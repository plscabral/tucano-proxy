use crate::{
    commands, dispatch,
    proxy::empty_flow,
    state::AppState,
    storage::{Flow, FlowState, Storage},
};
use serde_json::json;
use std::sync::{atomic::Ordering, Arc};
fn fixture() -> (tempfile::TempDir, Arc<AppState>, Flow) {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(dir.path().into()).unwrap());
    let flow = empty_flow(
        &state,
        "POST".into(),
        "http".into(),
        "example.test".into(),
        80,
        "/api?access%5Ftoken=secret&safe=yes".into(),
    );
    (dir, state, flow)
}
#[test]
fn privacy_generation_blocks_old_and_private_requests_after_reenable() {
    let (_dir, state, mut flow) = fixture();
    let old = state.capture_generation();
    state.retain(&flow, old, "flow:new").unwrap();
    commands::set_private_mode(state.clone(), true).unwrap();
    let private = state.capture_generation();
    commands::set_private_mode(state.clone(), false).unwrap();
    flow.res_body = Some("secret response".into());
    flow.state = FlowState::Complete;
    assert!(!state.retain(&flow, old, "flow:update").unwrap());
    assert!(!state.retain(&flow, private, "flow:new").unwrap());
    assert!(state.storage.lock().list().unwrap().is_empty());
}
#[test]
fn annotated_flow_and_redacted_query_survive_completion_and_restart() {
    let (dir, state, mut flow) = fixture();
    let generation = state.capture_generation();
    state.retain(&flow, generation, "flow:new").unwrap();
    commands::update_flow_note(state.clone(), flow.id.clone(), Some("investigate".into())).unwrap();
    commands::update_flow_mark(state.clone(), flow.id.clone(), Some("purple".into())).unwrap();
    flow.ended_at = Some(flow.started_at + 2);
    flow.state = FlowState::Complete;
    state.retain(&flow, generation, "flow:update").unwrap();
    drop(state);
    let state = AppState::new(dir.path().into()).unwrap();
    let loaded = state.storage.lock().get(&flow.id).unwrap().unwrap();
    assert_eq!(loaded.note.as_deref(), Some("investigate"));
    assert_eq!(loaded.mark.as_deref(), Some("purple"));
    assert!(!loaded.path.contains("secret"));
    assert!(loaded.path.contains("safe=yes"));
}
#[test]
fn invalid_import_rolls_back_even_after_valid_rows() {
    let (dir, state, flow) = fixture();
    state.storage.lock().upsert(&flow).unwrap();
    let source = dir.path().join("invalid.tucano");
    let conn = rusqlite::Connection::open(&source).unwrap();
    conn.execute_batch(
        "CREATE TABLE flows(id TEXT PRIMARY KEY,idx INTEGER NOT NULL,data TEXT NOT NULL)",
    )
    .unwrap();
    let mut imported = flow.clone();
    imported.id = "new-flow".into();
    conn.execute(
        "INSERT INTO flows VALUES(?1,?2,?3)",
        rusqlite::params![
            imported.id,
            imported.index,
            serde_json::to_string(&imported).unwrap()
        ],
    )
    .unwrap();
    conn.execute("INSERT INTO flows VALUES('broken',9,'not JSON')", [])
        .unwrap();
    drop(conn);
    assert!(state.storage.lock().replace_from(&source).is_err());
    assert!(state.storage.lock().get(&flow.id).unwrap().is_some());
    assert!(state.storage.lock().get("new-flow").unwrap().is_none());
    let missing = dir.path().join("missing.tucano");
    assert!(state.storage.lock().replace_from(&missing).is_err());
    assert!(!missing.exists());
}
#[test]
fn failed_subset_export_does_not_replace_destination() {
    let (dir, state, _) = fixture();
    let dest = dir.path().join("existing.tucano");
    std::fs::write(&dest, b"original file").unwrap();
    assert!(state
        .storage
        .lock()
        .save_subset_to(&dest, &["missing".into()])
        .is_err());
    assert_eq!(std::fs::read(dest).unwrap(), b"original file");
}
#[tokio::test]
async fn lifecycle_bind_failure_is_reported_and_restart_releases_listener() {
    let (_dir, state, _) = fixture();
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    assert!(
        commands::start_proxy(state.clone(), occupied.local_addr().unwrap().port())
            .await
            .is_err()
    );
    assert!(!state.running.load(Ordering::SeqCst));
    commands::start_proxy(state.clone(), 0).await.unwrap();
    let port = state.port.load(Ordering::SeqCst);
    let connection = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    drop(connection);
    commands::stop_proxy(state.clone()).await.unwrap();
    let rebound = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    drop(rebound);
    commands::start_proxy(state.clone(), port).await.unwrap();
    commands::stop_proxy(state.clone()).await.unwrap();
}
#[tokio::test]
async fn metadata_query_combines_filters_and_excludes_bodies() {
    let (_dir, state, mut flow) = fixture();
    flow.status = Some(503);
    flow.duration_ms = Some(200);
    flow.req_body = Some("payload".into());
    state.storage.lock().upsert(&flow).unwrap();
    let page = dispatch(
        state.clone(),
        "query_flows",
        json!({"filter":"host:example status>=500 duration:>100ms","limit":1,"sort":"duration"}),
    )
    .await
    .unwrap();
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["id"], flow.id);
    assert!(page["items"][0]["reqBody"].is_null());
    assert_eq!(
        dispatch(state, "query_flows", json!({"filter":"status:<400"}))
            .await
            .unwrap()["total"],
        0
    );
}
#[tokio::test]
async fn compose_without_logging_works_in_private_mode_without_publication() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (_dir, state, _) = fixture();
    commands::set_private_mode(state.clone(), true).unwrap();
    let mut events = state.subscribe();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let origin = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::with_capacity(512);
        while !request.ends_with(b"\r\n\r\n") {
            let mut chunk = [0u8; 1024];
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(count > 0 && request.len() + count <= 8192);
            request.extend_from_slice(&chunk[..count]);
        }
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await.unwrap();
    });
    let flow = commands::compose_request(
        state.clone(),
        "GET".into(),
        format!("http://127.0.0.1:{port}/"),
        vec![],
        None,
        false,
    )
    .await
    .unwrap();
    origin.await.unwrap();
    assert_eq!(flow.status, Some(200));
    assert_eq!(flow.res_body.as_deref(), Some("ok"));
    assert_eq!(state.storage.lock().count().unwrap(), 0);
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}
#[test]
fn import_sanitizes_credentials_before_committing() {
    let (dir, _state, mut flow) = fixture();
    flow.req_headers = vec![("Authorization".into(), "Bearer secret".into())];
    let source = dir.path().join("source.tucano");
    let conn = rusqlite::Connection::open(&source).unwrap();
    conn.execute_batch(
        "CREATE TABLE flows(id TEXT PRIMARY KEY,idx INTEGER NOT NULL,data TEXT NOT NULL)",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO flows VALUES(?1,?2,?3)",
        rusqlite::params![flow.id, flow.index, serde_json::to_string(&flow).unwrap()],
    )
    .unwrap();
    drop(conn);
    let mut storage = Storage::open(&dir.path().join("target.db")).unwrap();
    storage.replace_from(&source).unwrap();
    let loaded = storage.get(&flow.id).unwrap().unwrap();
    assert_eq!(loaded.req_headers[0].1, "[REDACTED]");
    assert!(!loaded.path.contains("secret"));
}

#[tokio::test]
async fn binary_capture_survives_session_reopen_and_json_har_exports() {
    use base64::Engine;
    let (dir, state, mut flow) = fixture();
    let bytes = b"\x89PNG\r\n\x1a\n\x00\xffopaque\0payload";
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    flow.req_body = Some(encoded.clone());
    flow.req_body_encoding = "base64".into();
    flow.res_body = Some(encoded.clone());
    flow.res_body_encoding = "base64".into();
    flow.req_content_type = Some("application/octet-stream".into());
    flow.res_content_type = Some("image/png".into());
    flow.req_size = bytes.len() as i64;
    flow.res_size = bytes.len() as i64;
    flow.ended_at = Some(flow.started_at + 1);
    flow.state = FlowState::Complete;
    state.storage.lock().upsert(&flow).unwrap();
    let session = dir.path().join("binary.tucano");
    state.storage.lock().save_to(&session).unwrap();
    drop(state);
    let state = Arc::new(AppState::new(dir.path().into()).unwrap());
    commands::open_session(state.clone(), session.to_string_lossy().into_owned()).unwrap();
    let loaded = state.storage.lock().get(&flow.id).unwrap().unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(loaded.res_body.unwrap())
            .unwrap(),
        bytes
    );
    assert_eq!(loaded.res_body_encoding, "base64");
    let exported = dispatch(state.clone(), "export_flows", json!({"format":"json"}))
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(exported.as_str().unwrap()).unwrap();
    assert_eq!(json[0]["reqBody"], encoded);
    assert_eq!(json[0]["resBody"], encoded);
    let har = dispatch(state, "export_flows", json!({"format":"har"}))
        .await
        .unwrap();
    let har: serde_json::Value = serde_json::from_str(har.as_str().unwrap()).unwrap();
    assert_eq!(
        har["log"]["entries"][0]["response"]["content"]["encoding"],
        "base64"
    );
    assert_eq!(
        har["log"]["entries"][0]["response"]["content"]["text"],
        encoded
    );
}
