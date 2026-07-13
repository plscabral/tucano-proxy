//! System proxy changes are deliberately transactional.  A stale snapshot is
//! restored on the next launch, which is the only reliable recovery path after
//! a power loss or force-quit (the process cannot run cleanup in that case).
use std::path::Path;

pub fn enable(data_dir: &Path, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(target_os = "macos")]
    { macos::enable(data_dir, port) }
    #[cfg(target_os = "windows")]
    { windows::enable(data_dir, port) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = (data_dir, port); Ok(()) }
}

pub fn restore(data_dir: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(target_os = "macos")]
    { macos::restore(data_dir) }
    #[cfg(target_os = "windows")]
    { windows::restore(data_dir) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = data_dir; Ok(()) }
}

/// Best-effort startup recovery.  Failure is returned to the caller so it is
/// visible in logs, but must not prevent the app from opening.
pub fn recover_if_needed(data_dir: &Path) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(target_os = "macos")]
    { macos::recover_if_needed(data_dir) }
    #[cfg(target_os = "windows")]
    { windows::recover_if_needed(data_dir) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = data_dir; Ok(false) }
}

#[cfg(target_os = "macos")]
mod macos {
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    #[derive(Clone, Default, Serialize, Deserialize)]
    struct Endpoint { enabled: bool, server: String, port: u16 }
    #[derive(Clone, Default, Serialize, Deserialize)]
    struct Pac { enabled: bool, url: String }
    #[derive(Default, Serialize, Deserialize)]
    struct ServiceSnapshot { web: Endpoint, secure: Endpoint, pac: Pac, bypass: Vec<String> }
    #[derive(Default, Serialize, Deserialize)]
    struct Snapshot { services: HashMap<String, ServiceSnapshot> }

    fn snapshot_path(data_dir: &Path) -> PathBuf { data_dir.join("system-proxy-snapshot.json") }

    fn services() -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        let out = Command::new("networksetup").arg("-listallnetworkservices").output()?;
        if !out.status.success() { return Err(format!("networksetup -listallnetworkservices: {}", String::from_utf8_lossy(&out.stderr).trim()).into()); }
        Ok(String::from_utf8_lossy(&out.stdout).lines().skip(1)
            .filter(|l| !l.starts_with('*')).map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()).collect())
    }

    fn output(args: &[&str]) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let out = Command::new("networksetup").args(args).output()?;
        if !out.status.success() { return Err(format!("networksetup {:?}: {}", args, String::from_utf8_lossy(&out.stderr).trim()).into()); }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
    fn run(args: &[&str]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> { output(args).map(|_| ()) }
    fn value(text: &str, key: &str) -> String {
        text.lines().find_map(|l| l.trim().strip_prefix(key).map(|v| v.trim().to_string())).unwrap_or_default()
    }
    fn enabled(text: &str) -> bool { value(text, "Enabled:").eq_ignore_ascii_case("yes") }
    fn endpoint(flag: &str, svc: &str) -> Result<Endpoint, Box<dyn std::error::Error + Send + Sync>> {
        let text = output(&[flag, svc])?;
        Ok(Endpoint { enabled: enabled(&text), server: value(&text, "Server:"), port: value(&text, "Port:").parse().unwrap_or(0) })
    }
    fn pac(svc: &str) -> Result<Pac, Box<dyn std::error::Error + Send + Sync>> {
        let text = output(&["-getautoproxyurl", svc])?;
        Ok(Pac { enabled: enabled(&text), url: value(&text, "URL:") })
    }
    fn bypass(svc: &str) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(output(&["-getproxybypassdomains", svc])?.lines().map(str::trim).filter(|s| !s.is_empty() && !s.starts_with("There aren't any")).map(str::to_string).collect())
    }
    fn capture() -> Result<Snapshot, Box<dyn std::error::Error + Send + Sync>> {
        let mut services_out = HashMap::new();
        for svc in services()? {
            services_out.insert(svc.clone(), ServiceSnapshot { web: endpoint("-getwebproxy", &svc)?, secure: endpoint("-getsecurewebproxy", &svc)?, pac: pac(&svc)?, bypass: bypass(&svc)? });
        }
        Ok(Snapshot { services: services_out })
    }
    fn write_snapshot(data_dir: &Path, snapshot: &Snapshot) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        fs::create_dir_all(data_dir)?;
        let final_path = snapshot_path(data_dir);
        let temp = final_path.with_extension("tmp");
        fs::write(&temp, serde_json::to_vec(snapshot)?)?;
        fs::rename(temp, final_path)?;
        Ok(())
    }
    fn read_snapshot(data_dir: &Path) -> Result<Option<Snapshot>, Box<dyn std::error::Error + Send + Sync>> {
        let path = snapshot_path(data_dir);
        if !path.exists() { return Ok(None); }
        Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
    }
    fn restore_endpoint(svc: &str, set_flag: &str, state_flag: &str, saved: &Endpoint) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Restore endpoint details before its enabled state.  This preserves a
        // disabled corporate proxy instead of leaving Tucano's localhost value
        // waiting to be accidentally re-enabled later.
        if !saved.server.is_empty() && saved.port > 0 { run(&[set_flag, svc, &saved.server, &saved.port.to_string()])?; }
        run(&[state_flag, svc, if saved.enabled { "on" } else { "off" }])
    }
    fn restore_snapshot(snapshot: &Snapshot) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        for (svc, saved) in &snapshot.services {
            restore_endpoint(svc, "-setwebproxy", "-setwebproxystate", &saved.web)?;
            restore_endpoint(svc, "-setsecurewebproxy", "-setsecurewebproxystate", &saved.secure)?;
            if !saved.pac.url.is_empty() { run(&["-setautoproxyurl", svc, &saved.pac.url])?; }
            run(&["-setautoproxystate", svc, if saved.pac.enabled { "on" } else { "off" }])?;
            let mut args = vec!["-setproxybypassdomains", svc.as_str()];
            if saved.bypass.is_empty() { args.push(""); } else { args.extend(saved.bypass.iter().map(String::as_str)); }
            run(&args)?;
        }
        Ok(())
    }

    pub fn enable(data_dir: &Path, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // A snapshot left behind means a crash. Recover it first, then take a
        // fresh snapshot; never overwrite the user's original configuration.
        if read_snapshot(data_dir)?.is_some() { restore(data_dir)?; }
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
        let Some(snapshot) = read_snapshot(data_dir)? else { return Ok(()); };
        restore_snapshot(&snapshot)?;
        fs::remove_file(snapshot_path(data_dir))?;
        Ok(())
    }
    pub fn recover_if_needed(data_dir: &Path) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if read_snapshot(data_dir)?.is_none() { return Ok(false); }
        restore(data_dir)?;
        Ok(true)
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    fn snapshot_path(data_dir: &Path) -> PathBuf { data_dir.join("system-proxy-snapshot.reg") }
    fn run(args: &[&str]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let out = Command::new("reg").args(args).creation_flags(CREATE_NO_WINDOW).output()?;
        if !out.status.success() { return Err(format!("reg {:?}: {}", args, String::from_utf8_lossy(&out.stderr).trim()).into()); }
        Ok(())
    }
    pub fn enable(data_dir: &Path, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if snapshot_path(data_dir).exists() { restore(data_dir)?; }
        fs::create_dir_all(data_dir)?;
        let snapshot = snapshot_path(data_dir).to_string_lossy().into_owned();
        run(&["export", KEY, &snapshot, "/y"])?;
        run(&["add", KEY, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", "", "/f"])?;
        run(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"])?;
        run(&["add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", &format!("127.0.0.1:{port}"), "/f"])?;
        run(&["add", KEY, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", "", "/f"])
    }
    pub fn restore(data_dir: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let path = snapshot_path(data_dir);
        if !path.exists() { return Ok(()); }
        let snapshot = path.to_string_lossy().into_owned();
        run(&["import", &snapshot])?;
        fs::remove_file(path)?;
        Ok(())
    }
    pub fn recover_if_needed(data_dir: &Path) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if !snapshot_path(data_dir).exists() { return Ok(false); }
        restore(data_dir)?; Ok(true)
    }
}
