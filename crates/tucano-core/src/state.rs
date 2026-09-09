use crate::{
    ca::CertAuthority,
    mcp_settings::McpSettings,
    ssl_settings::SslSettings,
    storage::{Flow, Storage},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
};

pub type BoxResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreEvent {
    pub sequence: u64,
    pub event: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Lifecycle {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed(String),
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    private_mode: bool,
    keep_limit: usize,
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub ca: CertAuthority,
    pub storage: Mutex<Storage>,
    pub running: AtomicBool,
    pub port: AtomicU16,
    pub system_proxy_on: AtomicBool,
    pub stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub proxy_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub lifecycle: tokio::sync::Mutex<Lifecycle>,
    pub ssl: Mutex<SslSettings>,
    /// Revocation boundary for upstream HTTPS handshakes and pooled sockets.
    pub tls_policy: Mutex<tokio_util::sync::CancellationToken>,
    pub proxy_connections: Mutex<tokio_util::sync::CancellationToken>,
    pub keep_limit: AtomicUsize,
    pub private_mode: AtomicBool,
    /// Protects privacy transitions and retention/event publication together.
    pub capture_gate: Mutex<()>,
    pub generation: AtomicU64,
    pub next_flow_index: AtomicU64,
    pub mcp_settings: Mutex<McpSettings>,
    pub mcp_stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub proxy_generation: AtomicU64,
    pub mcp_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub mcp_lifecycle: tokio::sync::Mutex<()>,
    events: tokio::sync::broadcast::Sender<CoreEvent>,
    event_sequence: Mutex<u64>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> BoxResult<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let data_dir = data_dir.canonicalize()?;
        let ca = CertAuthority::load_or_create(&data_dir)?;
        let mut storage = Storage::open(&data_dir.join("flows.db"))?;
        let preferences = match std::fs::read(data_dir.join("preferences.json")) {
            Ok(bytes) => serde_json::from_slice::<Preferences>(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Preferences::default(),
            Err(e) => return Err(e.into()),
        };
        if preferences.private_mode {
            storage.clear()?;
        }
        storage.finalize_pending("capture interrupted by previous process shutdown")?;
        let next_index = storage.next_index()? as u64;
        let ssl = SslSettings::load(&data_dir)?;
        let mcp = McpSettings::load(&data_dir)?;
        let (events, _) = tokio::sync::broadcast::channel(1024);
        Ok(Self {
            data_dir,
            ca,
            storage: Mutex::new(storage),
            running: AtomicBool::new(false),
            port: AtomicU16::new(8888),
            system_proxy_on: AtomicBool::new(false),
            stop_tx: Mutex::new(None),
            proxy_task: Mutex::new(None),
            lifecycle: tokio::sync::Mutex::new(Lifecycle::Stopped),
            ssl: Mutex::new(ssl),
            tls_policy: Mutex::new(tokio_util::sync::CancellationToken::new()),
            proxy_connections: Mutex::new(tokio_util::sync::CancellationToken::new()),
            proxy_generation: AtomicU64::new(0),
            keep_limit: AtomicUsize::new(preferences.keep_limit),
            private_mode: AtomicBool::new(preferences.private_mode),
            capture_gate: Mutex::new(()),
            generation: AtomicU64::new(0),
            next_flow_index: AtomicU64::new(next_index),
            mcp_settings: Mutex::new(mcp),
            mcp_stop_tx: Mutex::new(None),
            mcp_task: Mutex::new(None),
            mcp_lifecycle: tokio::sync::Mutex::new(()),
            events,
            event_sequence: Mutex::new(0),
        })
    }
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<CoreEvent> {
        self.events.subscribe()
    }
    pub fn emit(&self, event: &str, payload: impl Serialize) -> Result<(), String> {
        let payload = serde_json::to_value(payload).map_err(|e| e.to_string())?;
        let mut sequence = self.event_sequence.lock();
        *sequence += 1;
        // Absence of subscribers is not a publication failure.
        let _ = self.events.send(CoreEvent {
            sequence: *sequence,
            event: event.into(),
            payload,
        });
        Ok(())
    }
    pub fn capture_generation(&self) -> Option<u64> {
        let _guard = self.capture_gate.lock();
        (!self.private_mode.load(Ordering::SeqCst)).then(|| self.generation.load(Ordering::SeqCst))
    }
    pub fn retain(
        &self,
        flow: &Flow,
        generation: Option<u64>,
        event: &str,
    ) -> Result<bool, String> {
        let _guard = self.capture_gate.lock();
        if self.private_mode.load(Ordering::SeqCst)
            || generation != Some(self.generation.load(Ordering::SeqCst))
        {
            return Ok(false);
        }
        let mut safe = flow.clone();
        crate::storage::redact_flow(&mut safe);
        let mut storage = self.storage.lock();
        // A late completion must not resurrect a deleted or trimmed flow.
        if event == "flow:update" {
            let Some(existing) = storage.get(&safe.id).map_err(|e| e.to_string())? else {
                return Ok(false);
            };
            safe.note = existing.note;
            safe.mark = existing.mark;
        }
        storage.upsert(&safe).map_err(|e| e.to_string())?;
        self.emit(event, &safe)?;
        let limit = self.keep_limit.load(Ordering::Relaxed);
        if limit > 0 {
            let ids = storage.trim_to_limit(limit)?;
            if !ids.is_empty() {
                self.emit("flows:trimmed", ids)?;
            }
        }
        Ok(true)
    }
    pub fn save_preferences(&self) -> Result<(), String> {
        let p = Preferences {
            private_mode: self.private_mode.load(Ordering::SeqCst),
            keep_limit: self.keep_limit.load(Ordering::Relaxed),
        };
        let bytes = serde_json::to_vec(&p).map_err(|e| e.to_string())?;
        let tmp = self.data_dir.join("preferences.json.tmp");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(tmp, self.data_dir.join("preferences.json")).map_err(|e| e.to_string())
    }
    pub fn allocate_index(&self) -> i64 {
        self.next_flow_index.fetch_add(1, Ordering::Relaxed) as i64
    }
}

pub async fn cleanup(state: &Arc<AppState>) -> Result<(), String> {
    let result = crate::commands::stop_proxy(state.clone()).await;
    crate::mcp_bridge::stop(state).await;
    result
}
