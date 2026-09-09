use super::*;
use axum::http::Request as HttpRequest;
use tower::ServiceExt;

fn fixture() -> (tempfile::TempDir, Shared, Router) {
    let root = tempfile::tempdir().unwrap();
    let directory = create_session(root.path(), "test").unwrap();
    let core = Arc::new(AppState::new(directory.clone()).unwrap());
    let descriptor = RuntimeDescriptor {
        api_version: 1,
        session: "test".into(),
        pid: std::process::id(),
        endpoint: "http://127.0.0.1:7777".into(),
        token: auth::secret(),
        read_token: auth::secret(),
        proxy_port: 8888,
        started_at: 1,
        instance_id: uuid::Uuid::new_v4().to_string(),
    };
    let runtime_path = directory.join("runtime.json");
    runtime::write_descriptor(&runtime_path, &descriptor).unwrap();
    let (shutdown, _) = watch::channel(false);
    let state = Arc::new(ServiceState {
        core,
        credentials: RwLock::new(Credentials::new(descriptor)),
        runtime_path,
        api_port: 7777,
        shutdown,
        mutation: Mutex::new(()),
        transfers: Arc::new(Semaphore::new(2)),
    });
    (root, state.clone(), router(state))
}
fn request(
    method: &str,
    path: &str,
    token: Option<&str>,
    body: impl Into<Body>,
) -> HttpRequest<Body> {
    let mut request = HttpRequest::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, "127.0.0.1:7777")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    request.body(body.into()).unwrap()
}
async fn payload(response: Response) -> Value {
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}
fn flow(id: &str) -> tucano_core::storage::Flow {
    serde_json::from_value(json!({
        "id":id,"index":1,"startedAt":1,"method":"GET","scheme":"http","host":"example.test","port":80,
        "path":"/","httpVersion":"HTTP/1.1","reqHeaders":[],"reqBodyEncoding":"utf8","reqSize":0,
        "resHeaders":[],"resBodyEncoding":"utf8","resSize":0,"state":"complete"
    })).unwrap()
}

#[tokio::test]
async fn transport_denies_read_mutations_arbitrary_files_and_rebinding() {
    let (root, state, app) = fixture();
    let (admin, read) = {
        let credentials = state.credentials.read();
        (
            credentials.descriptor.token.clone(),
            credentials.descriptor.read_token.clone(),
        )
    };
    let response = app
        .clone()
        .oneshot(request("GET", "/api/v1/runtime", None, Body::empty()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    for command in ["start_proxy", "clear_flows", "get_mcp_settings"] {
        let response = app
            .clone()
            .oneshot(request(
                "POST",
                "/api/v1/invoke",
                Some(&read),
                json!({"command":command,"args":{}}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let target = root.path().join("must-not-exist");
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/v1/invoke",
            Some(&admin),
            json!({"command":"write_text_file","args":{"path":target,"contents":"unsafe"}})
                .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!target.exists());
    let mut rebound = request("GET", "/api/v1/runtime", Some(&admin), Body::empty());
    rebound
        .headers_mut()
        .insert(header::HOST, "attacker.example:7777".parse().unwrap());
    assert_eq!(
        app.clone().oneshot(rebound).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let response = app
        .oneshot(request(
            "GET",
            "/api/v1/runtime",
            Some(&read),
            Body::empty(),
        ))
        .await
        .unwrap();
    let result = payload(response).await;
    assert_eq!(result["result"]["scope"], "read");
    assert!(!result.to_string().contains(&admin));
    assert!(!result.to_string().contains(&read));
}

#[tokio::test]
async fn login_rotation_revokes_cookie_and_token_without_revoking_admin() {
    let (_root, state, app) = fixture();
    let admin = state.credentials.read().descriptor.token.clone();
    let read = state.credentials.read().descriptor.read_token.clone();
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/v1/auth",
            None,
            json!({"token":read}).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    let mut logged_in = request("GET", "/api/v1/runtime", None, Body::empty());
    logged_in
        .headers_mut()
        .insert(header::COOKIE, cookie.parse().unwrap());
    assert_eq!(
        app.clone().oneshot(logged_in).await.unwrap().status(),
        StatusCode::OK
    );
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/v1/auth/rotate",
            Some(&admin),
            json!({"scope":"read"}).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let fresh = payload(response).await["result"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        app.clone()
            .oneshot(request(
                "GET",
                "/api/v1/runtime",
                Some(&read),
                Body::empty()
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let mut stale_cookie = request("GET", "/api/v1/runtime", None, Body::empty());
    stale_cookie
        .headers_mut()
        .insert(header::COOKIE, cookie.parse().unwrap());
    assert_eq!(
        app.clone().oneshot(stale_cookie).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(request(
                "GET",
                "/api/v1/runtime",
                Some(&fresh),
                Body::empty()
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/v1/shutdown",
                Some(&fresh),
                Body::empty()
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.oneshot(request(
            "POST",
            "/api/v1/shutdown",
            Some(&admin),
            Body::empty()
        ))
        .await
        .unwrap()
        .status(),
        StatusCode::OK
    );
    assert!(*state.shutdown.borrow());
}

#[tokio::test]
async fn invalid_import_preserves_capture_and_valid_import_replaces_atomically() {
    let (root, state, app) = fixture();
    state.core.storage.lock().upsert(&flow("original")).unwrap();
    let admin = state.credentials.read().descriptor.token.clone();
    let read = state.credentials.read().descriptor.read_token.clone();
    let source = root.path().join("import.sqlite");
    let connection = rusqlite::Connection::open(&source).unwrap();
    connection.execute_batch("CREATE TABLE flows(id TEXT PRIMARY KEY, idx INTEGER NOT NULL, data TEXT NOT NULL); INSERT INTO flows VALUES('invalid', 1, '{}');").unwrap();
    drop(connection);
    let invalid = std::fs::read(&source).unwrap();
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/v1/session/import",
            Some(&admin),
            invalid,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        state
            .core
            .storage
            .lock()
            .get("original")
            .unwrap()
            .unwrap()
            .id,
        "original"
    );
    std::fs::remove_file(&source).unwrap();
    let mut source_storage = tucano_core::storage::Storage::open(&source).unwrap();
    source_storage.upsert(&flow("replacement")).unwrap();
    drop(source_storage);
    let valid = std::fs::read(&source).unwrap();
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/v1/session/import",
            Some(&admin),
            valid,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(payload(response).await["result"]["imported"], 1);
    assert!(state.core.storage.lock().get("original").unwrap().is_none());
    assert_eq!(
        state
            .core
            .storage
            .lock()
            .get("replacement")
            .unwrap()
            .unwrap()
            .id,
        "replacement"
    );
    let response = app
        .oneshot(request(
            "GET",
            "/api/v1/session/export?ids=replacement",
            Some(&read),
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), transfer::MAX_TRANSFER)
        .await
        .unwrap();
    let exported = root.path().join("exported.sqlite");
    std::fs::write(&exported, bytes).unwrap();
    let exported = tucano_core::storage::Storage::open(&exported).unwrap();
    assert_eq!(
        exported.get("replacement").unwrap().unwrap().id,
        "replacement"
    );
    assert_eq!(exported.count().unwrap(), 1);
}

#[tokio::test]
async fn live_composer_does_not_block_privacy_or_shutdown() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (_root, state, app) = fixture();
    let admin = state.credentials.read().descriptor.token.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (began, observed) = tokio::sync::oneshot::channel();
    let origin = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::with_capacity(512);
        while !request.ends_with(b"\r\n\r\n") {
            let mut chunk = [0u8; 1024];
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(count > 0 && request.len() + count <= 8192);
            request.extend_from_slice(&chunk[..count]);
        }
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n9\r\ndata: x\n\n\r\n").await.unwrap();
        let _ = began.send(());
        loop {
            tokio::time::sleep(Duration::from_millis(20)).await;
            if socket.write_all(b"9\r\ndata: x\n\n\r\n").await.is_err() {
                break;
            }
        }
    });
    let compose = app.clone().oneshot(request("POST", "/api/v1/invoke", Some(&admin), json!({
        "command":"compose_request","args":{"method":"GET","url":format!("http://{address}/events"),"headers":[],"body":null,"log":false}
    }).to_string()));
    let pending = tokio::spawn(compose);
    tokio::time::timeout(Duration::from_secs(3), observed)
        .await
        .unwrap()
        .unwrap();
    let privacy = app.clone().oneshot(request(
        "POST",
        "/api/v1/invoke",
        Some(&admin),
        json!({
            "command":"set_private_mode","args":{"enabled":true}
        })
        .to_string(),
    ));
    let response = tokio::time::timeout(Duration::from_secs(2), privacy)
        .await
        .expect("live network I/O must not block privacy")
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        app.oneshot(request(
            "POST",
            "/api/v1/shutdown",
            Some(&admin),
            Body::empty()
        ))
        .await
        .unwrap()
        .status(),
        StatusCode::OK
    );
    let response = tokio::time::timeout(Duration::from_secs(2), pending)
        .await
        .expect("shutdown must cancel live sends")
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    origin.abort();
}

#[tokio::test]
async fn exported_large_body_round_trips_through_session_import() {
    let (_root, state, app) = fixture();
    let mut original = flow("large");
    original.res_body = Some("x".repeat(9 * 1024 * 1024));
    original.res_size = original.res_body.as_ref().unwrap().len() as i64;
    state.core.storage.lock().upsert(&original).unwrap();
    let admin = state.credentials.read().descriptor.token.clone();
    let response = app
        .clone()
        .oneshot(request(
            "GET",
            "/api/v1/session/export",
            Some(&admin),
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), transfer::MAX_TRANSFER)
        .await
        .unwrap();
    state.core.storage.lock().clear().unwrap();
    let response = app
        .oneshot(request(
            "POST",
            "/api/v1/session/import",
            Some(&admin),
            bytes,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let restored = state.core.storage.lock().get("large").unwrap().unwrap();
    assert_eq!(restored.res_body, original.res_body);
}
