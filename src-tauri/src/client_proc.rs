use base64::Engine;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::process::Command;

#[derive(Default, Clone)]
pub struct ClientInfo {
    pub name: Option<String>,
    pub icon_data_url: Option<String>,
}

static ICON_CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Resolve the local client port → process info (best-effort, OS specific).
pub fn resolve(port: u16) -> ClientInfo {
    #[cfg(target_os = "macos")]
    { return macos::resolve(port); }
    #[cfg(target_os = "windows")]
    { return windows::resolve(port); }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = port; ClientInfo::default() }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    pub fn resolve(port: u16) -> ClientInfo {
        let Some(pid) = pid_for_port(port) else { return ClientInfo::default() };
        let exe = exe_path(pid);
        let bundle = exe.as_deref().and_then(outer_app_bundle);
        let name = bundle.as_ref().map(|b| bundle_display_name(b))
            .or_else(|| process_name(pid));
        let icon = bundle.as_ref().and_then(|b| icon_for_bundle(b));
        ClientInfo { name, icon_data_url: icon }
    }

    fn pid_for_port(port: u16) -> Option<u32> {
        let out = Command::new("lsof")
            .args(["-nP", "-F", "p", "-iTCP", "-sTCP:ESTABLISHED"])
            .arg(format!("-iTCP:{port}"))
            .output().ok()?;
        if !out.status.success() { return None; }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|l| l.strip_prefix('p').and_then(|p| p.parse().ok()))
    }

    fn exe_path(pid: u32) -> Option<String> {
        let out = Command::new("ps").args(["-p", &pid.to_string(), "-o", "comm="]).output().ok()?;
        if !out.status.success() { return None; }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }

    fn process_name(pid: u32) -> Option<String> {
        exe_path(pid).map(|p| {
            std::path::Path::new(&p)
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or(p)
        })
    }

    fn outer_app_bundle(exe: &str) -> Option<String> {
        // walk leftmost ".app" component for outer bundle
        let parts: Vec<&str> = exe.split('/').collect();
        let idx = parts.iter().position(|p| p.ends_with(".app"))?;
        Some(parts[..=idx].join("/"))
    }

    fn bundle_display_name(bundle: &str) -> String {
        let plist = format!("{bundle}/Contents/Info");
        if let Ok(out) = Command::new("defaults").args(["read", &plist, "CFBundleDisplayName"]).output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() { return s; }
            }
        }
        if let Ok(out) = Command::new("defaults").args(["read", &plist, "CFBundleName"]).output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() { return s; }
            }
        }
        std::path::Path::new(bundle)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| bundle.to_string())
    }

    fn icon_for_bundle(bundle: &str) -> Option<String> {
        if let Some(cached) = ICON_CACHE.lock().get(bundle).cloned() { return cached; }

        let resources = format!("{bundle}/Contents/Resources");
        let icns_path = find_icns(&resources, bundle);
        let Some(icns) = icns_path else {
            tracing::debug!("no .icns found for bundle {bundle}");
            ICON_CACHE.lock().insert(bundle.to_string(), None);
            return None;
        };

        let id = uuid::Uuid::new_v4();
        let png = std::env::temp_dir().join(format!("tucano-icon-{id}.png"));
        let png_str = png.to_string_lossy().to_string();
        let out = Command::new("sips")
            .args(["-s", "format", "png", "-Z", "64"])
            .arg(&icns)
            .args(["--out", &png_str])
            .output();
        let ok = out.as_ref().map(|o| o.status.success()).unwrap_or(false);
        if !ok {
            if let Ok(o) = out {
                tracing::debug!("sips failed for {icns}: {}", String::from_utf8_lossy(&o.stderr));
            }
            ICON_CACHE.lock().insert(bundle.to_string(), None);
            return None;
        }

        let bytes = match std::fs::read(&png) { Ok(b) => b, Err(_) => {
            ICON_CACHE.lock().insert(bundle.to_string(), None);
            return None;
        }};
        let _ = std::fs::remove_file(&png);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let data_url = format!("data:image/png;base64,{b64}");
        ICON_CACHE.lock().insert(bundle.to_string(), Some(data_url.clone()));
        Some(data_url)
    }

    fn find_icns(resources: &str, bundle: &str) -> Option<String> {
        // 1. Try CFBundleIconFile from Info.plist
        let plist = format!("{bundle}/Contents/Info");
        if let Ok(o) = Command::new("defaults").args(["read", &plist, "CFBundleIconFile"]).output() {
            if o.status.success() {
                let raw = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !raw.is_empty() {
                    let mut p = format!("{resources}/{raw}");
                    if !p.ends_with(".icns") { p.push_str(".icns"); }
                    if std::path::Path::new(&p).exists() { return Some(p); }
                }
            }
        }
        // 2. Try CFBundleIconName (asset catalog name)
        if let Ok(o) = Command::new("defaults").args(["read", &plist, "CFBundleIconName"]).output() {
            if o.status.success() {
                let raw = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !raw.is_empty() {
                    let mut p = format!("{resources}/{raw}.icns");
                    if std::path::Path::new(&p).exists() { return Some(p); }
                    p = format!("{resources}/{raw}");
                    if std::path::Path::new(&p).exists() { return Some(p); }
                }
            }
        }
        // 3. Scan Resources/ for the first .icns file
        if let Ok(rd) = std::fs::read_dir(resources) {
            // Prefer common names
            let mut found: Option<String> = None;
            let preferred = ["AppIcon.icns", "Icon.icns", "app.icns"];
            let entries: Vec<_> = rd.flatten().collect();
            for name in preferred {
                if let Some(e) = entries.iter().find(|e| e.file_name() == *name) {
                    return Some(e.path().to_string_lossy().to_string());
                }
            }
            for e in entries {
                let n = e.file_name().to_string_lossy().to_lowercase();
                if n.ends_with(".icns") {
                    found.get_or_insert_with(|| e.path().to_string_lossy().to_string());
                }
            }
            return found;
        }
        None
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    pub fn resolve(port: u16) -> ClientInfo {
        let Some(pid) = pid_for_port(port) else { return ClientInfo::default() };
        let name = process_name(pid);
        ClientInfo { name, icon_data_url: None }
    }
    fn pid_for_port(port: u16) -> Option<u32> {
        let netstat = Command::new("netstat").args(["-ano", "-p", "TCP"]).output().ok()?;
        let s = String::from_utf8_lossy(&netstat.stdout);
        let needle = format!(":{port}");
        s.lines()
            .filter(|l| l.contains("ESTABLISHED") && l.contains(&needle))
            .filter_map(|l| l.split_whitespace().last().and_then(|p| p.parse().ok()))
            .next()
    }
    fn process_name(pid: u32) -> Option<String> {
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        s.lines().next().and_then(|l| {
            let parts: Vec<&str> = l.split(',').collect();
            parts.first().map(|n| n.trim_matches('"').trim_end_matches(".exe").to_string())
        })
    }
}
