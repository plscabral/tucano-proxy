use anyhow::{bail, Context, Result};
use rusqlite::{limits::Limit, Connection, OpenFlags};
use std::{
    collections::HashSet,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};
use tucano_core::storage::{Flow, Storage};

pub(crate) const MAX_TRANSFER: usize = 64 * 1024 * 1024;
// Any row in an accepted exported SQLite file must be accepted on import.
const MAX_FLOW: usize = MAX_TRANSFER;
const MAX_FLOWS: usize = 100_000;

pub(crate) fn serialized_size(flow: &Flow) -> Result<usize> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.checked_add(bytes.len()).ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "flow size overflow")
            })?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, flow)?;
    Ok(counter.0)
}
/// Uploaded SQLite is never attached to the live database. Validate a read-only
/// connection, deserialize every record, and copy only known data into a fresh
/// database. No uploaded schema, trigger, view, or PRAGMA reaches live storage.
pub(crate) fn sanitize_import(source: &Path, destination: &Path) -> Result<usize> {
    if std::fs::metadata(source)?.len() > MAX_TRANSFER as u64 {
        bail!("session exceeds 64 MiB");
    }
    let connection = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_FLOW as i32);
    connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 16 * 1024);
    connection.set_limit(Limit::SQLITE_LIMIT_COLUMN, 32);
    connection.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
    let steps = AtomicUsize::new(0);
    connection.progress_handler(
        10_000,
        Some(move || steps.fetch_add(1, Ordering::Relaxed) >= 500),
    );
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")?;
    let mut schema = connection.prepare("SELECT type, name, tbl_name FROM sqlite_schema")?;
    let objects = schema.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut has_flows = false;
    let mut count = 0;
    for object in objects {
        count += 1;
        if count > 8 {
            bail!("unexpected SQLite schema");
        }
        let (kind, name, table) = object?;
        if kind == "table" && name == "flows" && table == "flows" {
            has_flows = true;
        } else if kind == "index"
            && table == "flows"
            && (name == "flows_idx" || name == "sqlite_autoindex_flows_1")
        {
        } else {
            bail!("session contains unsupported SQLite objects");
        }
    }
    if !has_flows {
        bail!("session is missing the flows table");
    }
    let integrity: String = connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if integrity != "ok" {
        bail!("session SQLite integrity check failed");
    }
    let row_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM flows", [], |row| row.get(0))?;
    if row_count < 0 || row_count as usize > MAX_FLOWS {
        bail!("session exceeds 100,000 flows");
    }
    let mut clean =
        Storage::open(destination).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut statement = connection.prepare("SELECT id, idx, data FROM flows ORDER BY idx")?;
    let mut rows = statement.query([])?;
    let mut total = 0usize;
    let mut ids = HashSet::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let index: i64 = row.get(1)?;
        let json: String = row.get(2)?;
        total = total
            .checked_add(json.len())
            .context("session size overflow")?;
        if total > MAX_TRANSFER || json.len() > MAX_FLOW {
            bail!("session data exceeds transfer limits");
        }
        if id.is_empty() || id.len() > 256 || !ids.insert(id.clone()) {
            bail!("invalid or duplicate flow identifier");
        }
        if ids.len() > MAX_FLOWS {
            bail!("session exceeds 100,000 flows");
        }
        let flow: Flow = serde_json::from_str(&json).context("invalid flow data")?;
        if flow.id != id || flow.index != index {
            bail!("flow identity does not match its SQLite row");
        }
        clean
            .upsert(&flow)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    }
    Ok(ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_uploaded_triggers_and_invalid_rows() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("upload.sqlite");
        let clean = root.path().join("clean.sqlite");
        let connection = Connection::open(&source).unwrap();
        connection.execute_batch("CREATE TABLE flows(id TEXT PRIMARY KEY, idx INTEGER NOT NULL, data TEXT NOT NULL); CREATE TRIGGER surprise AFTER INSERT ON flows BEGIN DELETE FROM flows; END;").unwrap();
        assert!(sanitize_import(&source, &clean).is_err());
        connection
            .execute_batch("DROP TRIGGER surprise; INSERT INTO flows VALUES('broken',1,'{}');")
            .unwrap();
        assert!(sanitize_import(&source, &clean).is_err());
        connection.execute_batch("DELETE FROM flows;").unwrap();
        assert_eq!(sanitize_import(&source, &clean).unwrap(), 0);
    }
    #[test]
    fn refuses_non_sqlite_and_unrelated_schema() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("upload.sqlite");
        let clean = root.path().join("clean.sqlite");
        std::fs::write(&source, b"not SQLite").unwrap();
        assert!(sanitize_import(&source, &clean).is_err());
        std::fs::remove_file(&source).unwrap();
        let connection = Connection::open(&source).unwrap();
        connection
            .execute_batch("CREATE TABLE unrelated(value TEXT);")
            .unwrap();
        assert!(sanitize_import(&source, &clean).is_err());
    }
}
