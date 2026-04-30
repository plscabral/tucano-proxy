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
            let status = std::process::Command::new("security")
                .args([
                    "add-trusted-cert", "-r", "trustRoot",
                    "-k", &format!("{}/Library/Keychains/login.keychain-db", std::env::var("HOME").unwrap_or_default()),
                ])
                .arg(&self.cert_path)
                .status()?;
            if !status.success() { return Err("security add-trusted-cert failed".into()); }
        }
        #[cfg(target_os = "windows")]
        {
            let status = std::process::Command::new("certutil")
                .args(["-user", "-addstore", "ROOT"])
                .arg(&self.cert_path)
                .status()?;
            if !status.success() { return Err("certutil failed".into()); }
        }
        Ok(())
    }

    pub fn uninstall_from_system(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(target_os = "macos")]
        {
            // -t certificate is the type; -c matches by common name. macOS may
            // ask for the user's password via a system prompt — that's
            // expected when removing trust roots.
            let status = std::process::Command::new("security")
                .args(["delete-certificate", "-c", "Tucano Root CA", "-t"])
                .status()?;
            if !status.success() { return Err("security delete-certificate failed".into()); }
        }
        #[cfg(target_os = "windows")]
        {
            let status = std::process::Command::new("certutil")
                .args(["-user", "-delstore", "ROOT", "Tucano Root CA"])
                .status()?;
            if !status.success() { return Err("certutil -delstore failed".into()); }
        }
        Ok(())
    }

    pub fn is_installed(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("security")
                .args(["find-certificate", "-c", "Tucano Root CA"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("certutil")
                .args(["-user", "-store", "ROOT", "Tucano Root CA"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        { false }
    }
}
