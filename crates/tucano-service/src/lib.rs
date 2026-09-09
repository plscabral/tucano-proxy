//! Authenticated loopback transport for the reusable Tucano runtime.
mod auth;
mod runtime;
#[cfg(test)]
mod tests;
mod transfer;

use anyhow::{Context, Result};
use auth::{Credentials, Scope};
use axum::{
    body::{Body, Bytes},
    extract::{
        rejection::{BytesRejection, JsonRejection, QueryRejection},
        DefaultBodyLimit, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use parking_lot::RwLock;
pub use runtime::{create_session, delete_session, list_sessions, session_path, RuntimeDescriptor};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    io::Write,
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{watch, Mutex, Semaphore};
use tucano_core::state::AppState;

#[derive(Clone, Debug)]
pub struct ServeOptions {
    pub data_dir: PathBuf,
    pub session: String,
    pub api_port: u16,
    pub proxy_port: u16,
    pub capture: bool,
    pub system_proxy: bool,
}

#[derive(RustEmbed)]
#[folder = "../../dist/"]
struct Assets;

struct ServiceState {
    core: Arc<AppState>,
    credentials: RwLock<Credentials>,
    runtime_path: PathBuf,
    api_port: u16,
    shutdown: watch::Sender<bool>,
    mutation: Mutex<()>,
    transfers: Arc<Semaphore>,
}

type Shared = Arc<ServiceState>;

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}
impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "a valid session credential is required",
        )
    }
    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }
    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!("service operation failed: {error}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "local service operation failed",
        )
    }
    fn command(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        if lower.contains("not found") {
            Self::new(StatusCode::NOT_FOUND, "not_found", message)
        } else if lower.contains("already")
            || lower.contains("in use")
            || lower.contains("owns the system proxy")
        {
            Self::new(StatusCode::CONFLICT, "conflict", message)
        } else {
            Self::new(StatusCode::BAD_REQUEST, "command_failed", message)
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"apiVersion":1,"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}
fn success(result: Value) -> Json<Value> {
    Json(json!({"apiVersion":1,"result":result}))
}
fn json_body<T>(
    body: std::result::Result<Json<T>, JsonRejection>,
) -> std::result::Result<T, ApiError> {
    body.map(|Json(body)| body)
        .map_err(|error| ApiError::new(error.status(), "invalid_request", error.body_text()))
}
fn authenticated(
    state: &ServiceState,
    headers: &HeaderMap,
    required: Scope,
) -> std::result::Result<Scope, ApiError> {
    if *state.shutdown.borrow() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "shutting_down",
            "the service is shutting down",
        ));
    }
    let scope = state.credentials.read().authenticate(headers)?;
    if required == Scope::Admin && scope != Scope::Admin {
        return Err(ApiError::forbidden(
            "admin credentials are required for this operation",
        ));
    }
    Ok(scope)
}
fn runtime_value(state: &ServiceState, scope: Scope) -> Value {
    let credentials = state.credentials.read();
    let descriptor = &credentials.descriptor;
    json!({"session":descriptor.session,"instanceId":descriptor.instance_id,"scope":scope.as_str(),"proxyPort":state.core.port.load(Ordering::SeqCst),"endpoint":descriptor.endpoint,"version":env!("CARGO_PKG_VERSION")})
}

/// Run in the foreground. A descriptor is published only after the API and
/// requested capture listener are bound; all shutdown paths clean up the core.
pub async fn serve(options: ServeOptions) -> Result<()> {
    if options.proxy_port == 0 {
        anyhow::bail!("proxy port must be between 1 and 65535");
    }
    if options.system_proxy && !options.capture {
        anyhow::bail!("system proxy requires capture to be enabled");
    }
    let _lock = runtime::SessionLock::acquire(&options.data_dir, &options.session)?;
    let directory = create_session(&options.data_dir, &options.session)?;
    let runtime_path = directory.join("runtime.json");
    // Holding the OS lock is the sole authority: stale descriptors are not
    // evidence that a PID is ours and are never used to signal processes.
    if runtime_path.exists() {
        std::fs::remove_file(&runtime_path).context("remove stale runtime descriptor")?;
    }
    if Assets::get("index.html").is_none() {
        anyhow::bail!(
            "embedded web assets are missing; build the frontend before building the service"
        );
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, options.api_port))
        .await
        .context("bind loopback API listener")?;
    let api_port = listener.local_addr()?.port();
    let core =
        Arc::new(AppState::new(directory).map_err(|error| anyhow::anyhow!(error.to_string()))?);
    core.port.store(options.proxy_port, Ordering::SeqCst);
    let (shutdown, _) = watch::channel(false);
    let descriptor = RuntimeDescriptor {
        api_version: 1,
        session: options.session,
        pid: std::process::id(),
        endpoint: format!("http://127.0.0.1:{api_port}"),
        token: auth::secret(),
        read_token: auth::secret(),
        proxy_port: options.proxy_port,
        started_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64,
        instance_id: uuid::Uuid::new_v4().to_string(),
    };
    let state = Arc::new(ServiceState {
        core: core.clone(),
        credentials: RwLock::new(Credentials::new(descriptor)),
        runtime_path: runtime_path.clone(),
        api_port,
        shutdown,
        mutation: Mutex::new(()),
        transfers: Arc::new(Semaphore::new(2)),
    });
    let startup = async {
        let mcp = core.mcp_settings.lock().clone();
        if mcp.enabled {
            tucano_core::mcp_bridge::spawn(core.clone(), mcp.port, mcp.token)
                .await
                .map_err(anyhow::Error::msg)?;
        }
        if options.capture {
            let command = if options.system_proxy {
                "start_capture"
            } else {
                "start_proxy"
            };
            run_command(&state, command, json!({"port":options.proxy_port}))
                .await
                .map_err(|error| anyhow::anyhow!(error.message))?;
        }
        let credentials = state.credentials.read();
        runtime::write_descriptor(&runtime_path, &credentials.descriptor)?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = startup {
        if let Err(cleanup_error) = tucano_core::cleanup(&core).await {
            tracing::error!("startup cleanup failed: {cleanup_error}");
        }
        return Err(error);
    }
    let _descriptor = runtime::RuntimeGuard {
        path: runtime_path,
        instance: state.credentials.read().descriptor.instance_id.clone(),
    };
    let router = router(state.clone());
    let mut requested = state.shutdown.subscribe();
    let mut graceful = state.shutdown.subscribe();
    let server = axum::serve(listener, router).with_graceful_shutdown(async move {
        if !*graceful.borrow() {
            let _ = graceful.changed().await;
        }
    });
    let server = std::future::IntoFuture::into_future(server);
    tokio::pin!(server);
    let outcome = tokio::select! {
        result = &mut server => result.map_err(anyhow::Error::from),
        signal = shutdown_signal() => {
            let _ = state.shutdown.send(true);
            let drained = tokio::time::timeout(Duration::from_secs(5), &mut server).await;
            match (signal, drained) {
                (Err(error), _) => Err(error),
                (_, Ok(result)) => result.map_err(anyhow::Error::from),
                (_, Err(_)) => Ok(()),
            }
        },
        _ = requested.changed() => {
            match tokio::time::timeout(Duration::from_secs(5), &mut server).await {
                Ok(result) => result.map_err(anyhow::Error::from),
                Err(_) => Ok(()),
            }
        },
    };
    let _ = state.shutdown.send(true);
    let _mutation = state.mutation.lock().await;
    let cleanup = tucano_core::cleanup(&core)
        .await
        .map_err(anyhow::Error::msg);
    outcome.and(cleanup)
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result = tokio::signal::ctrl_c() => result?, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

fn router(state: Shared) -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/runtime", get(runtime_info))
        .route("/api/v1/auth", post(login))
        .route("/api/v1/auth/rotate", post(rotate))
        .route(
            "/api/v1/invoke",
            post(invoke).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route("/api/v1/events", get(events))
        .route("/api/v1/shutdown", post(shutdown))
        .route("/api/v1/session/export", get(export_session))
        .route(
            "/api/v1/session/import",
            post(import_session).layer(DefaultBodyLimit::max(transfer::MAX_TRANSFER)),
        )
        .route("/api/v1/ca", get(download_ca))
        .fallback(static_asset)
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), source_guard))
        .with_state(state)
}

async fn source_guard(State(state): State<Shared>, request: Request, next: Next) -> Response {
    if let Err(error) = auth::check_source(request.headers(), state.api_port) {
        return error.into_response();
    }
    if *state.shutdown.borrow() {
        return ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "shutting_down",
            "the service is shutting down",
        )
        .into_response();
    }
    let path = request.uri().path();
    let protected = path.starts_with("/api/") && path != "/api/v1/health" && path != "/api/v1/auth";
    if protected {
        let required = if matches!(
            path,
            "/api/v1/session/import" | "/api/v1/shutdown" | "/api/v1/auth/rotate"
        ) {
            Scope::Admin
        } else {
            Scope::Read
        };
        if let Err(error) = authenticated(&state, request.headers(), required) {
            return error.into_response();
        }
    }
    // Reserve before Axum buffers the body; unauthenticated uploads cannot
    // allocate transfer-sized buffers and concurrent imports are bounded.
    let _upload_permit = if path == "/api/v1/session/import" {
        match state.transfers.clone().try_acquire_owned() {
            Ok(permit) => Some(permit),
            Err(_) => {
                return ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "transfer_busy",
                    "two session transfers are already active",
                )
                .into_response()
            }
        }
    } else {
        None
    };
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; media-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"));
    response
}

async fn health() -> Json<Value> {
    Json(json!({"apiVersion":1,"version":env!("CARGO_PKG_VERSION"),"ready":true}))
}
async fn runtime_info(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> std::result::Result<Json<Value>, ApiError> {
    let scope = authenticated(&state, &headers, Scope::Read)?;
    Ok(success(runtime_value(&state, scope)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    token: String,
}
async fn login(
    State(state): State<Shared>,
    body: std::result::Result<Json<Login>, JsonRejection>,
) -> std::result::Result<Response, ApiError> {
    let body = json_body(body)?;
    let (scope, cookie) = {
        let credentials = state.credentials.read();
        let scope = credentials
            .token_scope(&body.token)
            .ok_or_else(ApiError::unauthorized)?;
        (scope, credentials.cookie(scope))
    };
    let mut response = success(runtime_value(&state, scope)).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(ApiError::internal)?,
    );
    Ok(response)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rotate {
    scope: Scope,
}
async fn rotate(
    State(state): State<Shared>,
    headers: HeaderMap,
    body: std::result::Result<Json<Rotate>, JsonRejection>,
) -> std::result::Result<Json<Value>, ApiError> {
    authenticated(&state, &headers, Scope::Admin)?;
    let body = json_body(body)?;
    let _mutation = state.mutation.lock().await;
    authenticated(&state, &headers, Scope::Admin)?;
    let mut credentials = state.credentials.write();
    // Recheck under the rotation lock so an already-revoked token cannot rotate
    // credentials a second time after waiting behind another request.
    if credentials.authenticate(&headers)? != Scope::Admin {
        return Err(ApiError::forbidden("admin credentials are required"));
    }
    let token = auth::secret();
    let mut descriptor = credentials.descriptor.clone();
    match body.scope {
        Scope::Read => descriptor.read_token = token.clone(),
        Scope::Admin => descriptor.token = token.clone(),
    }
    runtime::write_descriptor(&state.runtime_path, &descriptor).map_err(ApiError::internal)?;
    credentials.commit_rotation(descriptor, body.scope);
    Ok(success(json!({"scope":body.scope.as_str(),"token":token})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invocation {
    command: String,
    #[serde(default = "empty_args")]
    args: Value,
}
fn empty_args() -> Value {
    json!({})
}
async fn invoke(
    State(state): State<Shared>,
    headers: HeaderMap,
    body: std::result::Result<Json<Invocation>, JsonRejection>,
) -> std::result::Result<Json<Value>, ApiError> {
    authenticated(&state, &headers, Scope::Read)?;
    let body = json_body(body)?;
    if !body.args.is_object() {
        return Err(ApiError::invalid("args must be an object"));
    }
    let required = auth::command_scope(&body.command).ok_or_else(|| ApiError::forbidden("command is not available over this transport; use the dedicated upload/download routes"))?;
    authenticated(&state, &headers, required)?;
    let result = if matches!(body.command.as_str(), "compose_request" | "replay_flow") {
        // A live/SSE response must not monopolize capture, privacy or credential
        // control. Core state transitions have their own synchronization.
        let mut shutdown = state.shutdown.subscribe();
        if *shutdown.borrow() {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "shutting_down",
                "the service is shutting down",
            ));
        }
        tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(60), run_command(&state, &body.command, body.args)) => {
                result.map_err(|_| ApiError::new(StatusCode::GATEWAY_TIMEOUT, "request_timeout", "request exceeded the 60 second overall deadline; an already sent request cannot be retracted"))??
            }
            _ = shutdown.changed() => {
                return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "shutting_down", "request observation cancelled because the service is shutting down"));
            }
        }
    } else if required == Scope::Admin {
        let _mutation = state.mutation.lock().await;
        authenticated(&state, &headers, required)?;
        run_command(&state, &body.command, body.args).await?
    } else {
        tucano_core::dispatch(state.core.clone(), &body.command, body.args)
            .await
            .map_err(ApiError::command)?
    };
    Ok(success(result))
}

async fn run_command(
    state: &Shared,
    command: &str,
    args: Value,
) -> std::result::Result<Value, ApiError> {
    let result = tucano_core::dispatch(state.core.clone(), command, args)
        .await
        .map_err(ApiError::command);
    if result.is_ok()
        && matches!(
            command,
            "start_proxy" | "start_capture" | "stop_proxy" | "stop_capture"
        )
        && state.runtime_path.exists()
    {
        let mut credentials = state.credentials.write();
        let mut descriptor = credentials.descriptor.clone();
        descriptor.proxy_port = state.core.port.load(Ordering::SeqCst);
        runtime::write_descriptor(&state.runtime_path, &descriptor).map_err(ApiError::internal)?;
        credentials.descriptor = descriptor;
    }
    result
}

async fn shutdown(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> std::result::Result<Json<Value>, ApiError> {
    authenticated(&state, &headers, Scope::Admin)?;
    state.shutdown.send_replace(true);
    Ok(success(json!({"shuttingDown":true})))
}

async fn events(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> std::result::Result<Response, ApiError> {
    authenticated(&state, &headers, Scope::Read)?;
    let mut receiver = state.core.subscribe();
    let mut shutdown = state.shutdown.subscribe();
    let mut credential_tick = tokio::time::interval(Duration::from_secs(1));
    let instance = state.credentials.read().descriptor.instance_id.clone();
    let stream = async_stream::stream! {
        // We do not pretend that broadcast is a replay log. Every (re)connect
        // explicitly asks the consumer to refresh a snapshot before following.
        yield Ok::<Event, Infallible>(Event::default().event("resync").data(json!({"reason":"connected","instanceId":instance}).to_string()));
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                _ = credential_tick.tick() => {
                    if state.credentials.read().authenticate(&headers).is_err() { break; }
                },
                received = receiver.recv() => match received {
                    Ok(event) => {
                        if state.credentials.read().authenticate(&headers).is_err() { break; }
                        match serde_json::to_string(&event) {
                            Ok(data) => yield Ok(Event::default().id(event.sequence.to_string()).data(data)),
                            Err(_) => yield Ok(Event::default().event("resync").data("{\"reason\":\"serialization\"}")),
                        }
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        yield Ok(Event::default().event("resync").data(json!({"reason":"lagged","skipped":skipped}).to_string()));
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    };
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportQuery {
    ids: Option<String>,
}
async fn export_session(
    State(state): State<Shared>,
    headers: HeaderMap,
    query: std::result::Result<Query<ExportQuery>, QueryRejection>,
) -> std::result::Result<Response, ApiError> {
    authenticated(&state, &headers, Scope::Read)?;
    let Query(query) = query.map_err(|error| ApiError::invalid(error.body_text()))?;
    let ids = query.ids.map(|value| {
        value
            .split(',')
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    if ids
        .as_ref()
        .is_some_and(|ids| ids.len() > 10_000 || ids.iter().any(|id| id.len() > 256))
    {
        return Err(ApiError::invalid("too many or oversized flow identifiers"));
    }
    let permit = state.transfers.clone().try_acquire_owned().map_err(|_| {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "transfer_busy",
            "two session transfers are already active",
        )
    })?;
    let core = state.core.clone();
    let (directory, path) =
        tokio::task::spawn_blocking(move || -> Result<(tempfile::TempDir, PathBuf)> {
            let directory = tempfile::tempdir_in(&core.data_dir)?;
            let path = directory.path().join("session.sqlite");
            let storage = core.storage.lock();
            match ids {
                Some(ids) => {
                    let mut exported = tucano_core::storage::Storage::open(&path)
                        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                    let mut total = 0usize;
                    for id in ids {
                        if let Some(flow) = storage
                            .get(&id)
                            .map_err(|error| anyhow::anyhow!(error.to_string()))?
                        {
                            total = total
                                .checked_add(transfer::serialized_size(&flow)?)
                                .context("export size overflow")?;
                            if total > transfer::MAX_TRANSFER {
                                anyhow::bail!("session exceeds 64 MiB; export fewer flows");
                            }
                            exported
                                .upsert(&flow)
                                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                        }
                    }
                }
                None => {
                    let database = core.data_dir.join("flows.db");
                    let wal = core.data_dir.join("flows.db-wal");
                    let size = database
                        .metadata()?
                        .len()
                        .saturating_add(wal.metadata().map(|metadata| metadata.len()).unwrap_or(0));
                    if size > transfer::MAX_TRANSFER as u64 {
                        anyhow::bail!("session exceeds 64 MiB; export a subset of flows");
                    }
                    storage
                        .save_to(&path)
                        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                }
            }
            drop(storage);
            if path.metadata()?.len() > transfer::MAX_TRANSFER as u64 {
                anyhow::bail!("session exceeds 64 MiB; export a subset of flows");
            }
            Ok((directory, path))
        })
        .await
        .map_err(ApiError::internal)?
        .map_err(|error| {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "export_failed",
                error.to_string(),
            )
        })?;
    let length = path.metadata().map_err(ApiError::internal)?.len();
    let mut input = tokio::fs::File::open(path)
        .await
        .map_err(ApiError::internal)?;
    let stream = async_stream::stream! {
        use tokio::io::AsyncReadExt;
        let _directory = directory;
        let _permit = permit;
        loop {
            let mut buffer = vec![0u8; 64 * 1024];
            match input.read(&mut buffer).await {
                Ok(0) => break,
                Ok(count) => {
                    buffer.truncate(count);
                    yield Ok::<Bytes, std::io::Error>(Bytes::from(buffer));
                },
                Err(error) => { yield Err(error); break; },
            }
        }
    };
    let mut response = download_response(
        Body::from_stream(stream),
        "application/vnd.sqlite3",
        "tucano-session.sqlite",
    )?;
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    Ok(response)
}

async fn import_session(
    State(state): State<Shared>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, BytesRejection>,
) -> std::result::Result<Json<Value>, ApiError> {
    authenticated(&state, &headers, Scope::Admin)?;
    let bytes =
        body.map_err(|error| ApiError::new(error.status(), "invalid_upload", error.body_text()))?;
    if bytes.len() > transfer::MAX_TRANSFER {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "upload_too_large",
            "session exceeds 64 MiB",
        ));
    }
    if !bytes.starts_with(b"SQLite format 3\0") {
        return Err(ApiError::invalid("upload must be a SQLite session"));
    }
    let directory = state.core.data_dir.clone();
    let (clean, imported) =
        tokio::task::spawn_blocking(move || -> Result<(tempfile::NamedTempFile, usize)> {
            let mut upload = tempfile::NamedTempFile::new_in(&directory)?;
            upload.write_all(&bytes)?;
            upload.flush()?;
            let clean = tempfile::NamedTempFile::new_in(directory)?;
            let imported = transfer::sanitize_import(upload.path(), clean.path())?;
            Ok((clean, imported))
        })
        .await
        .map_err(ApiError::internal)?
        .map_err(|error| ApiError::invalid(format!("invalid session: {error}")))?;
    let _mutation = state.mutation.lock().await;
    authenticated(&state, &headers, Scope::Admin)?;
    let path = clean.path().to_str().ok_or_else(|| {
        ApiError::invalid("session data directory must be valid UTF-8 for imports")
    })?;
    tucano_core::dispatch(state.core.clone(), "open_session", json!({"path":path}))
        .await
        .map_err(ApiError::command)?;
    let _ = state
        .core
        .emit("session:imported", json!({"imported":imported}));
    Ok(success(json!({"imported":imported})))
}

async fn download_ca(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> std::result::Result<Response, ApiError> {
    authenticated(&state, &headers, Scope::Read)?;
    let pem = tucano_core::dispatch(state.core.clone(), "export_ca", json!({}))
        .await
        .map_err(ApiError::command)?;
    let pem = pem
        .as_str()
        .ok_or_else(|| ApiError::internal("certificate is not text"))?;
    download_response(
        Body::from(pem.to_owned()),
        "application/x-pem-file",
        "tucano-ca.pem",
    )
}
fn download_response(
    body: Body,
    content_type: &'static str,
    filename: &'static str,
) -> std::result::Result<Response, ApiError> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(body)
        .map_err(ApiError::internal)
}

async fn static_asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return ApiError::new(StatusCode::NOT_FOUND, "not_found", "API route not found")
            .into_response();
    }
    let path = if path.is_empty() { "index.html" } else { path };
    let (asset, mime) = match Assets::get(path) {
        Some(asset) => (
            Some(asset),
            mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string(),
        ),
        None if !path.contains('.') => (Assets::get("index.html"), "text/html".to_owned()),
        None => (None, String::new()),
    };
    match asset {
        Some(asset) => {
            let body = match asset.data {
                std::borrow::Cow::Borrowed(bytes) => Body::from(bytes),
                std::borrow::Cow::Owned(bytes) => Body::from(bytes),
            };
            ([(header::CONTENT_TYPE, mime)], body).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
