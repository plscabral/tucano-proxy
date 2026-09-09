//! Explicit, serialized system-proxy ownership shared by desktop, CLI and MCP.
use fs2::FileExt;
use std::path::{Path, PathBuf};

struct Owner {
    _lock: std::fs::File,
    data_dir: PathBuf,
}
static OWNER: parking_lot::Mutex<Option<Owner>> = parking_lot::Mutex::new(None);

pub fn owns(data_dir: &Path) -> bool {
    let Ok(canonical) = data_dir.canonicalize() else {
        return false;
    };
    OWNER
        .lock()
        .as_ref()
        .is_some_and(|owner| owner.data_dir == canonical)
}

fn acquire(data_dir: &Path) -> crate::state::BoxResult<Owner> {
    let dir = dirs::data_local_dir()
        .ok_or("user data directory unavailable")?
        .join("tucano-proxy/system-proxy-owner");
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("owner.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| "another Tucano session owns the system proxy")?;
    let metadata = dir.join("owner.json");
    if metadata.exists() {
        let previous: PathBuf = serde_json::from_slice(&std::fs::read(&metadata)?)?;
        platform_restore(&previous)?;
    }
    let data_dir = data_dir.canonicalize()?;
    std::fs::write(&metadata, serde_json::to_vec(&data_dir)?)?;
    Ok(Owner {
        _lock: lock,
        data_dir,
    })
}
pub fn enable(data_dir: &Path, port: u16) -> crate::state::BoxResult<()> {
    let mut owner = OWNER.lock();
    let canonical = data_dir.canonicalize()?;
    if let Some(active) = owner.as_ref() {
        if active.data_dir != canonical {
            return Err("another Tucano session owns the system proxy".into());
        }
    } else {
        *owner = Some(acquire(data_dir)?);
    }
    let result = platform_enable(data_dir, port);
    if let Err(error) = result {
        platform_restore(data_dir)
            .map_err(|restore| format!("{error}; rollback failed: {restore}"))?;
        *owner = None;
        return Err(error);
    }
    Ok(())
}
pub fn restore(data_dir: &Path) -> crate::state::BoxResult<()> {
    let mut owner = OWNER.lock();
    let Some(active) = owner.as_ref() else {
        return Ok(());
    };
    if active.data_dir != data_dir.canonicalize()? {
        return Err("system proxy belongs to another session".into());
    }
    platform_restore(data_dir)?;
    *owner = None;
    Ok(())
}
pub fn recover_if_needed(data_dir: &Path) -> crate::state::BoxResult<bool> {
    let owner = OWNER.lock();
    if owner.is_some() {
        return Err("system proxy currently owned; recovery refused".into());
    }
    let _lock = acquire(data_dir)?;
    let existed = data_dir.join("system-proxy-snapshot.json").exists()
        || data_dir.join("system-proxy-snapshot.reg").exists();
    platform_restore(data_dir)?;
    Ok(existed)
}
fn platform_enable(data_dir: &Path, port: u16) -> crate::state::BoxResult<()> {
    #[cfg(target_os = "macos")]
    {
        macos::enable(data_dir, port)
    }
    #[cfg(target_os = "windows")]
    {
        windows::enable(data_dir, port)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (data_dir, port);
        Err("automatic system proxy configuration is unsupported on this platform; configure HTTP_PROXY/HTTPS_PROXY explicitly".into())
    }
}
fn platform_restore(data_dir: &Path) -> crate::state::BoxResult<()> {
    #[cfg(target_os = "macos")]
    {
        macos::restore(data_dir)
    }
    #[cfg(target_os = "windows")]
    {
        windows::restore(data_dir)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = data_dir;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    #[derive(Clone, Default, Serialize, Deserialize)]
    struct Endpoint {
        enabled: bool,
        server: String,
        port: u16,
    }
    #[derive(Clone, Default, Serialize, Deserialize)]
    struct Pac {
        enabled: bool,
        url: String,
    }
    #[derive(Default, Serialize, Deserialize)]
    struct ServiceSnapshot {
        web: Endpoint,
        secure: Endpoint,
        pac: Pac,
        bypass: Vec<String>,
    }
    #[derive(Default, Serialize, Deserialize)]
    struct Snapshot {
        services: HashMap<String, ServiceSnapshot>,
    }

    fn snapshot_path(data_dir: &Path) -> PathBuf {
        data_dir.join("system-proxy-snapshot.json")
    }

    fn services() -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        let out = Command::new("networksetup")
            .arg("-listallnetworkservices")
            .output()?;
        if !out.status.success() {
            return Err(format!(
                "networksetup -listallnetworkservices: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )
            .into());
        }
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .skip(1)
            .filter(|l| !l.starts_with('*'))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }

    fn output(args: &[&str]) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let out = Command::new("networksetup").args(args).output()?;
        if !out.status.success() {
            return Err(format!(
                "networksetup {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr).trim()
            )
            .into());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
    fn run(args: &[&str]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        output(args).map(|_| ())
    }
    fn value(text: &str, key: &str) -> String {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(key).map(|v| v.trim().to_string()))
            .unwrap_or_default()
    }
    fn enabled(text: &str) -> bool {
        value(text, "Enabled:").eq_ignore_ascii_case("yes")
    }
    fn endpoint(
        flag: &str,
        svc: &str,
    ) -> Result<Endpoint, Box<dyn std::error::Error + Send + Sync>> {
        let text = output(&[flag, svc])?;
        Ok(Endpoint {
            enabled: enabled(&text),
            server: value(&text, "Server:"),
            port: value(&text, "Port:").parse().unwrap_or(0),
        })
    }
    fn pac(svc: &str) -> Result<Pac, Box<dyn std::error::Error + Send + Sync>> {
        let text = output(&["-getautoproxyurl", svc])?;
        Ok(Pac {
            enabled: enabled(&text),
            url: value(&text, "URL:"),
        })
    }
    fn bypass(svc: &str) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(output(&["-getproxybypassdomains", svc])?
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with("There aren't any"))
            .map(str::to_string)
            .collect())
    }
    fn capture() -> Result<Snapshot, Box<dyn std::error::Error + Send + Sync>> {
        let mut services_out = HashMap::new();
        for svc in services()? {
            services_out.insert(
                svc.clone(),
                ServiceSnapshot {
                    web: endpoint("-getwebproxy", &svc)?,
                    secure: endpoint("-getsecurewebproxy", &svc)?,
                    pac: pac(&svc)?,
                    bypass: bypass(&svc)?,
                },
            );
        }
        Ok(Snapshot {
            services: services_out,
        })
    }
    fn write_snapshot(
        data_dir: &Path,
        snapshot: &Snapshot,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        fs::create_dir_all(data_dir)?;
        let final_path = snapshot_path(data_dir);
        let temp = final_path.with_extension("tmp");
        fs::write(&temp, serde_json::to_vec(snapshot)?)?;
        fs::rename(temp, final_path)?;
        Ok(())
    }
    fn read_snapshot(
        data_dir: &Path,
    ) -> Result<Option<Snapshot>, Box<dyn std::error::Error + Send + Sync>> {
        let path = snapshot_path(data_dir);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
    }
    fn restore_endpoint(
        svc: &str,
        set_flag: &str,
        state_flag: &str,
        saved: &Endpoint,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Restore endpoint details before its enabled state.  This preserves a
        // disabled corporate proxy instead of leaving Tucano's localhost value
        // waiting to be accidentally re-enabled later.
        if !saved.server.is_empty() && saved.port > 0 {
            run(&[set_flag, svc, &saved.server, &saved.port.to_string()])?;
        }
        run(&[state_flag, svc, if saved.enabled { "on" } else { "off" }])
    }
    fn restore_snapshot(
        snapshot: &Snapshot,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        for (svc, saved) in &snapshot.services {
            restore_endpoint(svc, "-setwebproxy", "-setwebproxystate", &saved.web)?;
            restore_endpoint(
                svc,
                "-setsecurewebproxy",
                "-setsecurewebproxystate",
                &saved.secure,
            )?;
            if !saved.pac.url.is_empty() {
                run(&["-setautoproxyurl", svc, &saved.pac.url])?;
            }
            run(&[
                "-setautoproxystate",
                svc,
                if saved.pac.enabled { "on" } else { "off" },
            ])?;
            let mut args = vec!["-setproxybypassdomains", svc.as_str()];
            if saved.bypass.is_empty() {
                args.push("");
            } else {
                args.extend(saved.bypass.iter().map(String::as_str));
            }
            run(&args)?;
        }
        Ok(())
    }

    pub fn enable(
        data_dir: &Path,
        port: u16,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // A snapshot left behind means a crash. Recover it first, then take a
        // fresh snapshot; never overwrite the user's original configuration.
        if read_snapshot(data_dir)?.is_some() {
            restore(data_dir)?;
        }
        let snapshot = capture()?;
        write_snapshot(data_dir, &snapshot)?;
        let port = port.to_string();
        for svc in snapshot.services.keys() {
            run(&["-setautoproxystate", svc, "off"])?;
            run(&["-setwebproxy", svc, "127.0.0.1", &port])?;
            run(&["-setsecurewebproxy", svc, "127.0.0.1", &port])?;
            run(&["-setwebproxystate", svc, "on"])?;
            run(&["-setsecurewebproxystate", svc, "on"])?;
            run(&["-setproxybypassdomains", svc, ""])?;
        }
        Ok(())
    }
    pub fn restore(data_dir: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(snapshot) = read_snapshot(data_dir)? else {
            return Ok(());
        };
        restore_snapshot(&snapshot)?;
        fs::remove_file(snapshot_path(data_dir))?;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use serde::{Deserialize, Serialize};
    use std::{
        collections::BTreeMap,
        fs,
        io::Write,
        path::{Path, PathBuf},
    };
    use winreg::{enums::*, RegKey, RegValue};
    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    const VALUES: [&str; 4] = [
        "AutoConfigURL",
        "ProxyEnable",
        "ProxyServer",
        "ProxyOverride",
    ];
    #[derive(Serialize, Deserialize)]
    struct SavedValue {
        kind: u32,
        bytes: Vec<u8>,
    }
    type Snapshot = BTreeMap<String, Option<SavedValue>>;
    fn snapshot_path(dir: &Path) -> PathBuf {
        dir.join("system-proxy-snapshot.json")
    }
    fn key() -> std::io::Result<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(KEY, KEY_READ | KEY_WRITE)
    }
    fn raw(saved: &SavedValue) -> crate::state::BoxResult<RegValue> {
        let vtype = match saved.kind {
            0 => REG_NONE,
            1 => REG_SZ,
            2 => REG_EXPAND_SZ,
            3 => REG_BINARY,
            4 => REG_DWORD,
            5 => REG_DWORD_BIG_ENDIAN,
            6 => REG_LINK,
            7 => REG_MULTI_SZ,
            8 => REG_RESOURCE_LIST,
            9 => REG_FULL_RESOURCE_DESCRIPTOR,
            10 => REG_RESOURCE_REQUIREMENTS_LIST,
            11 => REG_QWORD,
            _ => return Err("invalid registry type in system proxy snapshot".into()),
        };
        Ok(RegValue {
            vtype,
            bytes: saved.bytes.clone(),
        })
    }
    fn delete_if_present(key: &RegKey, name: &str) -> std::io::Result<()> {
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
    fn notify() -> crate::state::BoxResult<()> {
        use windows_sys::Win32::Networking::WinInet::{
            InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
        };
        // These documented options accept a null handle and null, zero-length buffer.
        unsafe {
            if InternetSetOptionW(
                std::ptr::null_mut(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                std::ptr::null_mut(),
                0,
            ) == 0
                || InternetSetOptionW(
                    std::ptr::null_mut(),
                    INTERNET_OPTION_REFRESH,
                    std::ptr::null_mut(),
                    0,
                ) == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        Ok(())
    }
    pub fn enable(dir: &Path, port: u16) -> crate::state::BoxResult<()> {
        restore(dir)?;
        let key = key()?;
        let mut snapshot = Snapshot::new();
        for name in VALUES {
            let saved = match key.get_raw_value(name) {
                Ok(value) => Some(SavedValue {
                    kind: value.vtype as u32,
                    bytes: value.bytes,
                }),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            };
            snapshot.insert(name.into(), saved);
        }
        fs::create_dir_all(dir)?;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        temp.write_all(&serde_json::to_vec(&snapshot)?)?;
        temp.as_file().sync_all()?;
        temp.persist(snapshot_path(dir)).map_err(|e| e.error)?;
        key.set_value("AutoConfigURL", &"")?;
        key.set_value("ProxyEnable", &1u32)?;
        key.set_value("ProxyServer", &format!("127.0.0.1:{port}"))?;
        key.set_value("ProxyOverride", &"")?;
        notify()
    }
    pub fn restore(dir: &Path) -> crate::state::BoxResult<()> {
        let path = snapshot_path(dir);
        if !path.exists() {
            return restore_legacy(dir);
        }
        let snapshot: Snapshot = serde_json::from_slice(&fs::read(&path)?)?;
        if snapshot.len() != VALUES.len() || VALUES.iter().any(|name| !snapshot.contains_key(*name))
        {
            return Err("incomplete system proxy recovery snapshot".into());
        }
        // Validate all types before changing anything. Preserve the file on every failure.
        let values = VALUES
            .iter()
            .map(|name| Ok((*name, snapshot[*name].as_ref().map(raw).transpose()?)))
            .collect::<crate::state::BoxResult<Vec<_>>>()?;
        let key = key()?;
        for (name, value) in values {
            if let Some(value) = value {
                key.set_raw_value(name, &value)?;
            } else {
                delete_if_present(&key, name)?;
            }
        }
        notify()?;
        fs::remove_file(path)?;
        Ok(())
    }
    fn restore_legacy(dir: &Path) -> crate::state::BoxResult<()> {
        use std::os::windows::process::CommandExt;
        let path = dir.join("system-proxy-snapshot.reg");
        if !path.exists() {
            return Ok(());
        }
        let bytes = fs::read(&path)?;
        let text = if bytes.starts_with(&[0xff, 0xfe]) {
            if bytes.len() % 2 != 0 {
                return Err("invalid legacy registry snapshot".into());
            }
            String::from_utf16(
                &bytes[2..]
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|b| u16::from_le_bytes(*b))
                    .collect::<Vec<_>>(),
            )?
        } else {
            String::from_utf8(bytes)?
        };
        let section = format!("[HKEY_CURRENT_USER\\{KEY}]");
        let mut in_section = false;
        let mut found_section = false;
        let mut present = std::collections::HashSet::new();
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                in_section = line.eq_ignore_ascii_case(&section);
                found_section |= in_section;
            }
            if in_section {
                for name in VALUES {
                    if line.starts_with(&format!("\"{name}\"=")) {
                        present.insert(name);
                    }
                }
            }
        }
        if !found_section {
            return Err("legacy snapshot does not contain Internet Settings".into());
        }
        let output = std::process::Command::new("reg")
            .arg("import")
            .arg(&path)
            .creation_flags(0x0800_0000)
            .output()?;
        if !output.status.success() {
            return Err(format!(
                "legacy registry recovery failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        let key = key()?;
        for name in VALUES {
            if !present.contains(name) {
                delete_if_present(&key, name)?;
            }
        }
        notify()?;
        fs::remove_file(path)?;
        Ok(())
    }
}
