use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, Connection};
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
    #[serde(default)]
    pub mark: Option<String>,
    #[serde(default)]
    pub req_truncated: bool,
    #[serde(default)]
    pub res_truncated: bool,
    #[serde(default)]
    pub state: FlowState,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FlowState {
    #[default]
    Pending,
    Streaming,
    Complete,
    Truncated,
    Error,
    Tunnel,
}

pub struct Storage {
    pub(crate) conn: Connection,
}

const REDACTED: &str = "[REDACTED]";

static JSON_SECRET: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
    r#"(?i)(\"(?:authorization|cookie|set-cookie|token|access_token|refresh_token|id_token|api[_-]?key|secret|password)\"\s*:\s*\")[^\"]*"#,
).expect("valid redaction regex")
});
static FORM_SECRET: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
    r"(?i)((?:^|[?&\s])(?:token|access_token|refresh_token|id_token|api[_-]?key|secret|password)=)[^&\s]+",
).expect("valid redaction regex")
});
static BEARER_SECRET: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)(\bbearer\s+)[a-z0-9._~+/=-]+").expect("valid redaction regex"));

fn is_secret_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "set-cookie"
            | "x-api-key"
            | "x-auth-token"
            | "x-access-token"
    )
}

/// Produce the representation that may leave the process (UI events, SQLite,
/// sessions and MCP exports). The bytes forwarded on the wire are never
/// modified; only retained copies are redacted.
pub fn redact_flow(flow: &mut Flow) {
    flow.path = redact_query(&flow.path);
    for (name, value) in flow
        .req_headers
        .iter_mut()
        .chain(flow.res_headers.iter_mut())
    {
        if is_secret_header(name) {
            *value = REDACTED.into();
        } else {
            *value = BEARER_SECRET
                .replace_all(value, "${1}[REDACTED]")
                .into_owned();
        }
    }
    for (body, encoding) in [
        (&mut flow.req_body, flow.req_body_encoding.as_str()),
        (&mut flow.res_body, flow.res_body_encoding.as_str()),
    ] {
        if let Some(value) = body {
            // Opaque binary content must remain lossless for image/hex views, replay and export.
            // Its internal secrets cannot be identified safely; private mode retains no body.
            if encoding != "base64" {
                let redacted_body = JSON_SECRET.replace_all(value, "${1}[REDACTED]");
                *value = FORM_SECRET
                    .replace_all(&redacted_body, "${1}[REDACTED]")
                    .into_owned();
            }
        }
    }
}

pub fn redact_query(path: &str) -> String {
    let Some((base, query)) = path.split_once('?') else {
        return path.into();
    };
    let mut changed = false;
    let pairs: Vec<String> = query
        .split('&')
        .map(|pair| {
            let (key, _) = pair.split_once('=').unwrap_or((pair, ""));
            let decoded = url::form_urlencoded::parse(key.as_bytes())
                .next()
                .map(|(k, _)| k.to_ascii_lowercase())
                .unwrap_or_default();
            if matches!(
                decoded.as_str(),
                "authorization"
                    | "cookie"
                    | "token"
                    | "access_token"
                    | "refresh_token"
                    | "id_token"
                    | "api_key"
                    | "api-key"
                    | "apikey"
                    | "key"
                    | "secret"
                    | "password"
                    | "signature"
                    | "sig"
                    | "x-amz-signature"
            ) {
                changed = true;
                format!("{key}=%5BREDACTED%5D")
            } else {
                pair.into()
            }
        })
        .collect();
    if changed {
        format!("{base}?{}", pairs.join("&"))
    } else {
        path.into()
    }
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS flows (
              id TEXT PRIMARY KEY,
              idx INTEGER NOT NULL,
              data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS flows_idx ON flows(idx);
        "#,
        )?;
        let storage = Self { conn };
        // Migrate older captures through the current redaction boundary, one row at a time.
        let tx = storage.conn.unchecked_transaction()?;
        {
            let mut statement = tx.prepare("SELECT id,data FROM flows")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (id, data) = row?;
                let mut flow: Flow = serde_json::from_str(&data)?;
                redact_flow(&mut flow);
                let safe = serde_json::to_string(&flow)?;
                if safe != data {
                    tx.execute("UPDATE flows SET data=?1 WHERE id=?2", params![safe, id])?;
                }
            }
        }
        tx.commit()?;
        Ok(storage)
    }

    pub fn upsert(&mut self, f: &Flow) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut safe = f.clone();
        redact_flow(&mut safe);
        let json = serde_json::to_string(&safe)?;
        self.conn.execute(
            "INSERT INTO flows(id, idx, data) VALUES(?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET idx=excluded.idx, data=excluded.data",
            params![f.id, f.index, json],
        )?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Flow>, Box<dyn std::error::Error + Send + Sync>> {
        let mut s = self
            .conn
            .prepare("SELECT data FROM flows ORDER BY idx ASC")?;
        let rows = s.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(serde_json::from_str(&r?)?);
        }
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Result<Option<Flow>, Box<dyn std::error::Error + Send + Sync>> {
        let mut s = self.conn.prepare("SELECT data FROM flows WHERE id = ?1")?;
        let mut rows = s.query(params![id])?;
        if let Some(r) = rows.next()? {
            let s: String = r.get(0)?;
            Ok(Some(serde_json::from_str(&s)?))
        } else {
            Ok(None)
        }
    }

    pub fn clear(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.conn.execute("DELETE FROM flows", [])?;
        Ok(())
    }

    pub fn delete_many(
        &mut self,
        ids: &[String],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let tx = self.conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM flows WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn count(&self) -> crate::state::BoxResult<usize> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM flows", [], |r| r.get::<_, i64>(0))?
            as usize)
    }

    /// Delete the oldest flows so at most `max` remain. Returns the deleted ids.
    pub fn trim_to_limit(&mut self, max: usize) -> Result<Vec<String>, String> {
        let total: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM flows", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let to_delete = (total as usize).saturating_sub(max);
        if to_delete == 0 {
            return Ok(vec![]);
        }
        let ids: Vec<String> = {
            let mut s = self
                .conn
                .prepare("SELECT id FROM flows ORDER BY idx ASC LIMIT ?1")
                .map_err(|e| e.to_string())?;
            let rows = s
                .query_map([to_delete as i64], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        self.delete_many(&ids).map_err(|e| e.to_string())?;
        Ok(ids)
    }

    pub fn next_index(&self) -> crate::state::BoxResult<i64> {
        Ok(self
            .conn
            .query_row("SELECT COALESCE(MAX(idx), 0) + 1 FROM flows", [], |r| {
                r.get(0)
            })?)
    }

    pub fn save_to(&self, dest: &Path) -> crate::state::BoxResult<()> {
        self.save_selected(dest, None)
    }

    pub fn save_subset_to(&self, dest: &Path, ids: &[String]) -> crate::state::BoxResult<()> {
        self.save_selected(dest, Some(ids))
    }

    fn save_selected(&self, dest: &Path, ids: Option<&[String]>) -> crate::state::BoxResult<()> {
        if dest.exists()
            && self.conn.path().is_some_and(|source| {
                Path::new(source).canonicalize().ok() == dest.canonicalize().ok()
            })
        {
            return Err("session destination cannot replace the live capture database".into());
        }
        let parent = dest
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let temp = tempfile::NamedTempFile::new_in(parent)?;
        {
            let mut dst = Connection::open(temp.path())?;
            if let Some(ids) = ids {
                dst.execute_batch("CREATE TABLE flows(id TEXT PRIMARY KEY,idx INTEGER NOT NULL,data TEXT NOT NULL); CREATE INDEX flows_idx ON flows(idx);")?;
                let tx = dst.transaction()?;
                for id in ids {
                    let flow = self
                        .get(id)?
                        .ok_or_else(|| format!("flow not found: {id}"))?;
                    tx.execute(
                        "INSERT OR IGNORE INTO flows(id,idx,data) VALUES(?1,?2,?3)",
                        params![flow.id, flow.index, serde_json::to_string(&flow)?],
                    )?;
                }
                tx.commit()?;
            } else {
                let backup = rusqlite::backup::Backup::new(&self.conn, &mut dst)?;
                backup.run_to_completion(64, std::time::Duration::ZERO, None)?;
            }
        }
        temp.as_file().sync_all()?;
        temp.persist(dest).map_err(|e| e.error)?;
        Ok(())
    }

    pub fn replace_from(
        &mut self,
        src: &Path,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if std::fs::metadata(src)?.len() > 512 * 1024 * 1024 {
            return Err("session exceeds 512 MiB".into());
        }
        let other = Connection::open_with_flags(
            src,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        other.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")?;
        let unexpected: i64 = other.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE NOT ((type='table' AND name='flows') OR (type='index' AND tbl_name='flows'))",
            [], |r| r.get(0))?;
        if unexpected != 0 {
            return Err("unexpected session schema objects".into());
        }
        let valid: String = other.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if valid != "ok" {
            return Err("corrupt session".into());
        }
        let mut s = other.prepare("SELECT id, idx, length(CAST(data AS BLOB)), data FROM flows")?;
        let mut rows = s.query([])?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM flows", [])?;
        let mut count = 0usize;
        let mut total_bytes = 0usize;
        while let Some(row) = rows.next()? {
            count += 1;
            let id: String = row.get(0)?;
            let idx: i64 = row.get(1)?;
            let length: usize = row.get(2)?;
            total_bytes = total_bytes.saturating_add(length);
            if count > 100_000 || length > 64 * 1024 * 1024 || total_bytes > 512 * 1024 * 1024 {
                return Err("session capture limits exceeded".into());
            }
            let data: String = row.get(3)?;
            let mut flow: Flow = serde_json::from_str(&data)?;
            validate_flow(&flow)?;
            if flow.id != id || flow.index != idx {
                return Err("session row metadata does not match flow".into());
            }
            redact_flow(&mut flow);
            tx.execute(
                "INSERT INTO flows(id,idx,data) VALUES(?1,?2,?3)",
                params![id, idx, serde_json::to_string(&flow)?],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn restore_many(
        &mut self,
        flows: &[Flow],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let tx = self.conn.transaction()?;
        for flow in flows {
            validate_flow(flow)?;
            let mut safe = flow.clone();
            redact_flow(&mut safe);
            tx.execute("INSERT INTO flows(id,idx,data) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET idx=excluded.idx,data=excluded.data",
                params![safe.id, safe.index, serde_json::to_string(&safe)?])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn finalize_pending(&mut self, message: &str) -> crate::state::BoxResult<()> {
        let now = crate::proxy::now_ms();
        self.conn.execute("UPDATE flows SET data=json_set(data,'$.state','error','$.error',?1,'$.endedAt',?2,'$.durationMs',max(0,?2-json_extract(data,'$.startedAt'))) WHERE json_extract(data,'$.endedAt') IS NULL",
            params![message, now])?;
        Ok(())
    }
}

pub fn validate_flow(flow: &Flow) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if flow.id.is_empty()
        || flow.id.len() > 256
        || flow.index < 0
        || flow.host.is_empty()
        || flow.port == 0
        || !matches!(flow.scheme.as_str(), "http" | "https")
        || !flow.path.starts_with('/')
        || flow.req_size < 0
        || flow.res_size < 0
        || !matches!(flow.req_body_encoding.as_str(), "utf8" | "base64")
        || !matches!(flow.res_body_encoding.as_str(), "utf8" | "base64")
    {
        return Err("invalid flow metadata".into());
    }
    http::Method::from_bytes(flow.method.as_bytes())?;
    if flow.status.is_some_and(|s| !(100..=599).contains(&s)) {
        return Err("invalid response status".into());
    }
    Ok(())
}
