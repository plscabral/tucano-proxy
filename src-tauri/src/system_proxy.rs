pub fn set(on: bool, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    eprintln!("[tucano] system_proxy::set on={on} port={port}");
    #[cfg(target_os = "macos")]
    { macos::set(on, port) }
    #[cfg(target_os = "windows")]
    { windows::set(on, port) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = (on, port); Ok(()) }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::process::Command;

    fn services() -> Vec<String> {
        let out = Command::new("networksetup").arg("-listallnetworkservices").output();
        let stdout = match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(e) => { eprintln!("[tucano] networksetup -listallnetworkservices failed: {e}"); return vec![]; }
        };
        stdout
            .lines()
            .skip(1)
            .filter(|l| !l.starts_with('*'))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    fn run(args: &[&str]) {
        let out = Command::new("networksetup").args(args).output();
        match out {
            Ok(o) if o.status.success() => {}
            Ok(o) => eprintln!(
                "[tucano] networksetup {:?} failed: {} {}",
                args,
                String::from_utf8_lossy(&o.stdout).trim(),
                String::from_utf8_lossy(&o.stderr).trim(),
            ),
            Err(e) => eprintln!("[tucano] networksetup {:?} error: {e}", args),
        }
    }

    /// Read the current proxy bypass domains for a network service.
    fn get_bypass(svc: &str) -> Vec<String> {
        let out = Command::new("networksetup")
            .args(["-getproxybypassdomains", svc])
            .output();
        let stdout = match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => return vec![],
        };
        stdout
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && !s.starts_with("There aren't any"))
            .collect()
    }

    fn snapshot_path() -> std::path::PathBuf {
        dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("tucano")
            .join("bypass-snapshot.json")
    }

    fn save_snapshot(map: &std::collections::HashMap<String, Vec<String>>) {
        let path = snapshot_path();
        if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
        if let Ok(json) = serde_json::to_string(map) {
            let _ = std::fs::write(&path, json);
        }
    }

    fn load_snapshot() -> std::collections::HashMap<String, Vec<String>> {
        std::fs::read_to_string(snapshot_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn set(on: bool, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let svcs = services();
        if svcs.is_empty() {
            eprintln!("[tucano] no network services found");
        }
        let port_s = port.to_string();
        if on {
            // Snapshot current bypass list per service so we can restore on OFF,
            // then replace it with a loopback-only bypass. We deliberately keep
            // 127.0.0.1 / localhost / ::1 OUT of the proxy: routing loopback
            // through Tucano interferes with local services that own their TLS
            // (PJe Office's local signer, databases, dev tooling) without
            // actually helping — browsers hard-bypass loopback regardless.
            // localhost capture is done via the `tucano.local` / `tucano.test`
            // alias (a non-loopback hostname rewritten to 127.0.0.1 upstream),
            // so we must NOT bypass `*.local` here or the alias would never
            // reach the proxy. We also keep link-local (169.254/16) bypassed.
            let mut snap: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
            for svc in &svcs {
                snap.insert(svc.clone(), get_bypass(svc));
            }
            save_snapshot(&snap);

            for svc in &svcs {
                run(&["-setwebproxy", svc, "127.0.0.1", &port_s]);
                run(&["-setsecurewebproxy", svc, "127.0.0.1", &port_s]);
                run(&["-setproxybypassdomains", svc, "127.0.0.1", "localhost", "::1", "169.254/16"]);
            }
        } else {
            let snap = load_snapshot();
            for svc in &svcs {
                run(&["-setwebproxystate", svc, "off"]);
                run(&["-setsecurewebproxystate", svc, "off"]);

                // Restore prior bypass list, falling back to the macOS default.
                let prior = snap.get(svc).cloned().unwrap_or_else(|| {
                    vec!["*.local".to_string(), "169.254/16".to_string()]
                });
                let mut args: Vec<&str> = vec!["-setproxybypassdomains", svc];
                if prior.is_empty() {
                    args.push("");
                } else {
                    for d in &prior { args.push(d.as_str()); }
                }
                run(&args);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::process::Command;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn set(on: bool, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
        if on {
            let _ = Command::new("reg").args(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]).creation_flags(CREATE_NO_WINDOW).status();
            let _ = Command::new("reg").args(["add", key, "/v", "ProxyServer", "/t", "REG_SZ", "/d", &format!("127.0.0.1:{}", port), "/f"]).creation_flags(CREATE_NO_WINDOW).status();
            // Bypass loopback only. Routing 127.0.0.1 / localhost through the
            // proxy interferes with local services that own their TLS (PJe
            // Office's signer, etc.) without helping capture. Dev-server capture
            // goes through the `tucano.local` / `tucano.test` alias, which has a
            // dot and is NOT covered by these entries, so it still reaches us.
            let _ = Command::new("reg").args(["add", key, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", "localhost;127.0.0.1;[::1]", "/f"]).creation_flags(CREATE_NO_WINDOW).status();
        } else {
            let _ = Command::new("reg").args(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]).creation_flags(CREATE_NO_WINDOW).status();
            let _ = Command::new("reg").args(["add", key, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", "<local>", "/f"]).creation_flags(CREATE_NO_WINDOW).status();
        }
        Ok(())
    }
}
