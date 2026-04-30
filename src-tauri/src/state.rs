use crate::{ca::CertAuthority, ssl_settings::SslSettings, storage::Storage};
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16};
use tauri::{AppHandle, Manager};

pub type BoxResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub struct AppState {
    pub data_dir: PathBuf,
    pub ca: CertAuthority,
    pub storage: Mutex<Storage>,
    pub running: AtomicBool,
    pub port: AtomicU16,
    pub system_proxy_on: AtomicBool,
    pub stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub ssl: Mutex<SslSettings>,
    pub app: AppHandle,
}

impl AppState {
    pub fn new(app: AppHandle) -> BoxResult<Self> {
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("tucano"));
        std::fs::create_dir_all(&data_dir)?;
        let ca = CertAuthority::load_or_create(&data_dir)?;
        let storage = Storage::open(&data_dir.join("flows.db"))?;
        let ssl = SslSettings::load(&data_dir);
        Ok(Self {
            data_dir,
            ca,
            storage: Mutex::new(storage),
            running: AtomicBool::new(false),
            port: AtomicU16::new(8888),
            system_proxy_on: AtomicBool::new(false),
            stop_tx: Mutex::new(None),
            ssl: Mutex::new(ssl),
            app,
        })
    }
}
