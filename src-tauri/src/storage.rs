use rusqlite::{params, Connection};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub id: String,
    pub index: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub method: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub http_version: String,
    pub status: Option<i64>,
    pub status_text: Option<String>,
    pub req_headers: Vec<(String, String)>,
    pub req_body: Option<String>,
    pub req_body_encoding: String,
    pub req_content_type: Option<String>,
    pub req_size: i64,
    pub res_headers: Vec<(String, String)>,
    pub res_body: Option<String>,
    pub res_body_encoding: String,
    pub res_content_type: Option<String>,
    pub res_size: i64,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    #[serde(default)]
    pub client_app: Option<String>,
    #[serde(default)]
    pub client_port: Option<u16>,
    #[serde(default)]
    pub client_icon: Option<String>,
    /// Free-text note added by the user (Fiddler-style "comment" column).
    /// Persisted as part of the flow JSON; old captures missing this field
    /// deserialize fine via #[serde(default)].
    #[serde(default)]
    pub note: Option<String>,
}

pub struct Storage { conn: Connection }

const REDACTED: &str = "[REDACTED]";

static JSON_SECRET: Lazy<Regex> = Lazy::new(|| Regex::new(
    r#"(?i)(\"(?:authorization|cookie|set-cookie|token|access_token|refresh_token|id_token|api[_-]?key|secret|password)\"\s*:\s*\")[^\"]*"#,
).expect("valid redaction regex"));
static FORM_SECRET: Lazy<Regex> = Lazy::new(|| Regex::new(
    r"(?i)((?:^|[?&\s])(?:token|access_token|refresh_token|id_token|api[_-]?key|secret|password)=)[^&\s]+",
).expect("valid redaction regex"));
static BEARER_SECRET: Lazy<Regex> = Lazy::new(|| Regex::new(
    r"(?i)(\bbearer\s+)[a-z0-9._~+/=-]+",
).expect("valid redaction regex"));

fn is_secret_header(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "set-cookie" |
        "x-api-key" | "x-auth-token" | "x-access-token")
}

/// Produce the representation that may leave the process (UI events, SQLite,
/// sessions and MCP exports). The bytes forwarded on the wire are never
/// modified; only retained copies are redacted.
pub fn redact_flow(flow: &mut Flow) {
    for (name, value) in flow.req_headers.iter_mut().chain(flow.res_headers.iter_mut()) {
        if is_secret_header(name) {
            *value = REDACTED.into();
        } else {
            *value = BEARER_SECRET.replace_all(value, "${1}[REDACTED]").into_owned();
        }
    }
    for (body, encoding) in [
        (&mut flow.req_body, flow.req_body_encoding.as_str()),
        (&mut flow.res_body, flow.res_body_encoding.as_str()),
    ] {
        if let Some(value) = body {
            if encoding == "base64" {
                *value = "[REDACTED BINARY BODY]".into();
            } else {
                let redacted_body = JSON_SECRET.replace_all(value, "${1}[REDACTED]");
                *value = FORM_SECRET.replace_all(&redacted_body, "${1}[REDACTED]").into_owned();
            }
        }
    }
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let conn = Connection::open(path)?;
        conn.execute_batch(r#"
            CREATE TABLE IF NOT EXISTS flows (
              id TEXT PRIMARY KEY,
              idx INTEGER NOT NULL,
              data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS flows_idx ON flows(idx);
        "#)?;
        Ok(Self { conn })
    }

    pub fn upsert(&mut self, f: &Flow) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut safe = f.clone();
        redact_flow(&mut safe);
        let json = serde_json::to_string(&safe)?;
        self.conn.execute(
            "INSERT INTO flows(id, idx, data) VALUES(?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![f.id, f.index, json],
        )?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Flow>, Box<dyn std::error::Error + Send + Sync>> {
        let mut s = self.conn.prepare("SELECT data FROM flows ORDER BY idx ASC")?;
        let rows = s.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows { out.push(serde_json::from_str(&r?)?); }
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Option<Flow>, Box<dyn std::error::Error + Send + Sync>> {
        let mut s = self.conn.prepare("SELECT data FROM flows WHERE id = ?1")?;
        let mut rows = s.query(params![id])?;
        if let Some(r) = rows.next()? {
            let s: String = r.get(0)?;
            Ok(Some(serde_json::from_str(&s)?))
        } else { Ok(None) }
    }

    pub fn clear(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.conn.execute("DELETE FROM flows", [])?;
        Ok(())
    }

    pub fn delete_many(&mut self, ids: &[String]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let tx = self.conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM flows WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn count(&self) -> usize {
        self.conn.query_row("SELECT COUNT(*) FROM flows", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as usize
    }

    /// Delete the oldest flows so at most `max` remain. Returns the deleted ids.
    pub fn trim_to_limit(&mut self, max: usize) -> Vec<String> {
        let total = self.count();
        if total <= max { return vec![]; }
        let to_delete = total - max;
        let ids: Vec<String> = {
            let mut s = match self.conn.prepare("SELECT id FROM flows ORDER BY idx ASC LIMIT ?1") {
                Ok(s) => s,
                Err(_) => return vec![],
            };
            s.query_map([to_delete as i64], |r| r.get(0))
                .unwrap_or_else(|_| panic!("trim query failed"))
                .filter_map(|r| r.ok())
                .collect()
        };
        if !ids.is_empty() { let _ = self.delete_many(&ids); }
        ids
    }

    pub fn next_index(&self) -> i64 {
        self.conn
            .query_row("SELECT COALESCE(MAX(idx), 0) + 1 FROM flows", [], |r| r.get(0))
            .unwrap_or(1)
    }

    pub fn save_to(&self, dest: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut dst = Connection::open(dest)?;
        let bk = rusqlite::backup::Backup::new(&self.conn, &mut dst)?;
        bk.run_to_completion(64, std::time::Duration::from_millis(0), None)?;
        Ok(())
    }

    /// Like `save_to` but writes only the flows whose ids appear in `ids`.
    /// We don't use the SQLite backup API here because backup copies the
    /// entire table; instead we create a fresh schema and copy the matching
    /// rows row-by-row.
    pub fn save_subset_to(
        &self,
        dest: &Path,
        ids: &[String],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if dest.exists() {
            std::fs::remove_file(dest)?;
        }
        let mut dst = Connection::open(dest)?;
        dst.execute_batch(
            "CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, idx INTEGER NOT NULL, data TEXT NOT NULL);",
        )?;
        let tx = dst.transaction()?;
        {
            let mut sel = self.conn.prepare("SELECT idx, data FROM flows WHERE id = ?1")?;
            let mut ins = tx.prepare("INSERT INTO flows(id, idx, data) VALUES(?1, ?2, ?3)")?;
            for id in ids {
                let row = sel.query_row(params![id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                });
                if let Ok((idx, data)) = row {
                    ins.execute(params![id, idx, data])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn replace_from(&mut self, src: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.clear()?;
        let other = Connection::open(src)?;
        let mut s = other.prepare("SELECT id, idx, data FROM flows")?;
        let rows = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?;
        for row in rows {
            let (id, idx, data) = row?;
            self.conn.execute("INSERT INTO flows(id, idx, data) VALUES(?1, ?2, ?3)", params![id, idx, data])?;
        }
        Ok(())
    }
}
