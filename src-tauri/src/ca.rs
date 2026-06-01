use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, KeyUsagePurpose, BasicConstraints, IsCa};
use std::fs;
use std::path::{Path, PathBuf};

pub struct CertAuthority {
    pub cert_pem: String,
    pub key_pem: String,
    pub cert_path: PathBuf,
}

impl CertAuthority {
    pub fn load_or_create(dir: &Path) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let ca_dir = dir.join("ca");
        fs::create_dir_all(&ca_dir)?;
        let cert_path = ca_dir.join("tucano-root.pem");
        let key_path = ca_dir.join("tucano-root.key.pem");

        if cert_path.exists() && key_path.exists() {
            return Ok(Self {
                cert_pem: fs::read_to_string(&cert_path)?,
                key_pem: fs::read_to_string(&key_path)?,
                cert_path,
            });
        }

        let mut params = CertificateParams::new(vec!["Tucano Root CA".into()])?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "Tucano Root CA");
        dn.push(DnType::OrganizationName, "Tucano");
        params.distinguished_name = dn;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
            KeyUsagePurpose::DigitalSignature,
        ];

        let key = KeyPair::generate()?;
        let cert = params.self_signed(&key)?;
        let cert_pem = cert.pem();
        let key_pem = key.serialize_pem();
        fs::write(&cert_path, &cert_pem)?;
        fs::write(&key_path, &key_pem)?;

        Ok(Self { cert_pem, key_pem, cert_path })
    }

    pub fn install_to_system(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(target_os = "macos")]
        {
            // Install into the SYSTEM keychain with admin-domain trust for ALL
            // policies (note: no `-p`). This mirrors what Proxyman / Charles /
            // mkcert do, and it is the only configuration that runtime stacks
            // like .NET honor on macOS.
            //
            // Why not the login keychain + `-p ssl` (the old approach)? Browsers
            // honor user-domain, SSL-scoped trust, so it *looked* fine. But the
            // .NET chain builder on macOS only consults the *admin* trust domain
            // (System keychain), and evaluates the anchor under a generic policy
            // — so a login-keychain, SSL-only trust is invisible to it and every
            // HTTPS call through the proxy fails with `UntrustedRoot`. Trusting
            // for all policies in the admin domain fixes .NET (and Java, etc.)
            // while still working for browsers.
            //
            // Writing to the System keychain requires admin rights; macOS shows
            // a native authorization prompt the first time.
            let status = std::process::Command::new("security")
                .args([
                    "add-trusted-cert", "-d", "-r", "trustRoot",
                    "-k", "/Library/Keychains/System.keychain",
                ])
                .arg(&self.cert_path)
                .status()?;
            if !status.success() { return Err("security add-trusted-cert failed".into()); }
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let status = std::process::Command::new("certutil")
                .args(["-user", "-addstore", "ROOT"])
                .arg(&self.cert_path)
                .creation_flags(CREATE_NO_WINDOW)
                .status()?;
            if !status.success() { return Err("certutil failed".into()); }
        }
        Ok(())
    }

    pub fn uninstall_from_system(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(target_os = "macos")]
        {
            // Remove from the System keychain (where install_to_system now puts
            // it). -t also drops the cert's trust settings; -c matches by common
            // name. Targeting the System keychain needs admin rights, so macOS
            // prompts for a password — expected when removing trust roots.
            let status = std::process::Command::new("security")
                .args([
                    "delete-certificate", "-c", "Tucano Root CA", "-t",
                    "/Library/Keychains/System.keychain",
                ])
                .status()?;
            if !status.success() { return Err("security delete-certificate failed".into()); }
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let status = std::process::Command::new("certutil")
                .args(["-user", "-delstore", "ROOT", "Tucano Root CA"])
                .creation_flags(CREATE_NO_WINDOW)
                .status()?;
            if !status.success() { return Err("certutil -delstore failed".into()); }
        }
        Ok(())
    }

    pub fn is_installed(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            // We install into the admin trust domain (System keychain) with
            // trust for all policies (no -p), so the cert shows up under
            // `dump-trust-settings -d` with "Number of trust settings : 0" — an
            // empty trust array means "always trust". So presence of our cert in
            // the admin domain is exactly what we want to detect; there's no SSL
            // policy line to look for anymore. Reading the admin domain does not
            // require elevation.
            let out = std::process::Command::new("security")
                .args(["dump-trust-settings", "-d"])
                .output()
                .unwrap_or_else(|_| std::process::Output {
                    status: std::process::ExitStatus::default(),
                    stdout: vec![],
                    stderr: vec![],
                });
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines().any(|l| {
                let t = l.trim();
                t.starts_with("Cert ") && t.ends_with("Tucano Root CA")
            })
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std::process::Command::new("certutil")
                .args(["-user", "-store", "ROOT", "Tucano Root CA"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        { false }
    }
}
