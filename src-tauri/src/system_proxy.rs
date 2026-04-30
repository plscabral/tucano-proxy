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

    pub fn set(on: bool, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let svcs = services();
        if svcs.is_empty() {
            eprintln!("[tucano] no network services found");
        }
        let port_s = port.to_string();
        for svc in &svcs {
            if on {
                run(&["-setwebproxy", svc, "127.0.0.1", &port_s]);
                run(&["-setsecurewebproxy", svc, "127.0.0.1", &port_s]);
            } else {
                run(&["-setwebproxystate", svc, "off"]);
                run(&["-setsecurewebproxystate", svc, "off"]);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::process::Command;

    pub fn set(on: bool, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
        if on {
            let _ = Command::new("reg").args(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]).status();
            let _ = Command::new("reg").args(["add", key, "/v", "ProxyServer", "/t", "REG_SZ", "/d", &format!("127.0.0.1:{}", port), "/f"]).status();
        } else {
            let _ = Command::new("reg").args(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]).status();
        }
        Ok(())
    }
}
