use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose,
};
use std::fs;
use std::path::{Path, PathBuf};

pub struct CertAuthority {
    pub cert_pem: String,
    pub key_pem: String,
    pub cert_path: PathBuf,
}

impl CertAuthority {
    /// Inspect this directory's CA without creating files or repairing damaged material.
    pub fn load_existing(dir: &Path) -> crate::state::BoxResult<Option<Self>> {
        use std::io::Read;
        let ca_dir = dir.join("ca");
        match fs::symlink_metadata(&ca_dir) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("CA directory must be a real, non-symlink directory".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let cert_path = ca_dir.join("tucano-root.pem");
        let key_path = ca_dir.join("tucano-root.key.pem");
        let read_material = |path: &Path| -> crate::state::BoxResult<Option<String>> {
            let before = match fs::symlink_metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            if !before.is_file() || before.file_type().is_symlink() {
                return Err(format!(
                    "CA material must be a regular, non-symlink file: {}",
                    path.display()
                )
                .into());
            }
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let file = options.open(path)?;
            let after = file.metadata()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if before.dev() != after.dev() || before.ino() != after.ino() {
                    return Err("CA material changed during inspection; retry".into());
                }
            }
            if !after.is_file() || after.len() > 65_536 {
                return Err("CA material is not a regular PEM file of at most 64 KiB".into());
            }
            let mut text = String::new();
            file.take(65_537).read_to_string(&mut text)?;
            if text.len() > 65_536 {
                return Err("CA material exceeds 64 KiB".into());
            }
            Ok(Some(text))
        };
        let (cert_pem, key_pem) = match (read_material(&cert_path)?, read_material(&key_path)?) {
            (None, None) => return Ok(None),
            (Some(cert), Some(key)) => (cert, key),
            _ => return Err("Incomplete session CA: restore the matching tucano-root.pem and tucano-root.key.pem from your backup, or choose a new session. Existing files were not changed.".into()),
        };
        let params = CertificateParams::from_ca_cert_pem(&cert_pem)?;
        if !matches!(params.is_ca, IsCa::Ca(_))
            || (!params.key_usages.is_empty()
                && !params.key_usages.contains(&KeyUsagePurpose::KeyCertSign))
        {
            return Err("Session certificate is not a certificate-signing CA".into());
        }
        let key = KeyPair::from_pem(&key_pem)?;
        let ca = Self {
            cert_pem,
            key_pem,
            cert_path,
        };
        let der = ca.certificate_der()?;
        let (remaining, certificate) = x509_parser::parse_x509_certificate(&der)?;
        if !remaining.is_empty() || certificate.public_key().raw != key.public_key_der() {
            return Err("Session CA certificate and private key do not match. Existing files were not changed.".into());
        }
        Ok(Some(ca))
    }

    fn certificate_der(&self) -> crate::state::BoxResult<Vec<u8>> {
        use base64::Engine;
        let pem = self.cert_pem.trim();
        let body = pem
            .strip_prefix("-----BEGIN CERTIFICATE-----")
            .and_then(|body| body.strip_suffix("-----END CERTIFICATE-----"))
            .ok_or("Expected exactly one PEM certificate")?;
        let body: String = body
            .chars()
            .filter(|ch| !ch.is_ascii_whitespace())
            .collect();
        let der = base64::engine::general_purpose::STANDARD.decode(body)?;
        if der.is_empty() {
            return Err("empty CA certificate".into());
        }
        Ok(der)
    }

    /// `None` means this platform does not support automatic OS trust detection.
    /// Errors are distinct from a verified absence of trust.
    pub fn system_trust(&self) -> crate::state::BoxResult<Option<bool>> {
        #[cfg(target_os = "macos")]
        {
            if !self.present_in_keychain(Some("/Library/Keychains/System.keychain"))?
                && !self.present_in_keychain(None)?
            {
                return Ok(Some(false));
            }
            let output = std::process::Command::new("security")
                .args(["verify-cert", "-c"])
                .arg(&self.cert_path)
                .args(["-p", "basic", "-L", "-l"])
                .output()?;
            Ok(Some(output.status.success()))
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let fingerprint = self.fingerprint()?;
            for user in [true, false] {
                let mut command = std::process::Command::new("certutil");
                if user {
                    command.arg("-user");
                }
                let output = command
                    .args(["-store", "ROOT", &fingerprint])
                    .creation_flags(0x0800_0000)
                    .output()?;
                if output.status.success() {
                    return Ok(Some(true));
                }
                let message = format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                if !message.to_ascii_lowercase().contains("80092004") {
                    return Err(format!(
                        "Cannot inspect Windows root trust store: {}",
                        message.trim()
                    )
                    .into());
                }
            }
            Ok(Some(false))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Ok(None)
        }
    }

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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))?;
        }

        Ok(Self {
            cert_pem,
            key_pem,
            cert_path,
        })
    }

    /// SHA-1 is used only as the platform certificate identifier, never for signatures.
    pub fn fingerprint(&self) -> crate::state::BoxResult<String> {
        let der = self.certificate_der()?;
        use sha1::{Digest, Sha1};
        Ok(format!("{:X}", Sha1::digest(der)))
    }

    #[cfg(target_os = "macos")]
    fn present_in_keychain(&self, keychain: Option<&str>) -> crate::state::BoxResult<bool> {
        let fingerprint = self.fingerprint()?;
        let mut command = std::process::Command::new("security");
        command.args(["find-certificate", "-a", "-Z", "-c", "Tucano Root CA"]);
        if let Some(keychain) = keychain {
            command.arg(keychain);
        }
        let output = command.output()?;
        if !output.status.success() && output.status.code() != Some(44) {
            return Err(format!(
                "reading certificate keychain failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        Ok(String::from_utf8_lossy(&output.stdout).lines().any(|line| {
            line.trim()
                .strip_prefix("SHA-1 hash:")
                .is_some_and(|hash| hash.trim().eq_ignore_ascii_case(&fingerprint))
        }))
    }

    pub fn install_to_system(&self) -> crate::state::BoxResult<()> {
        #[cfg(target_os = "macos")]
        {
            if self.is_installed() {
                return Ok(());
            }
            // Keychain insertion needs elevation; admin-domain trust must be set as the user.
            // Never evict a certificate by subject: other sessions deliberately share the CN.
            if !self.present_in_keychain(Some("/Library/Keychains/System.keychain"))? {
                let cert = self.cert_path.to_string_lossy().replace('\'', "'\\''");
                let inner = format!(
                    "security add-certificates -k /Library/Keychains/System.keychain '{cert}'"
                );
                let script = format!(
                    "do shell script \"{}\" with administrator privileges",
                    inner.replace('\\', "\\\\").replace('"', "\\\"")
                );
                let output = std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output()?;
                if !output.status.success() {
                    return Err(format!(
                        "adding this session's CA failed: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    )
                    .into());
                }
            }
            let output = std::process::Command::new("security")
                .args(["add-trusted-cert", "-d", "-r", "trustRoot"])
                .arg(&self.cert_path)
                .output()?;
            if !output.status.success() {
                return Err(format!(
                    "trusting this session's CA failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )
                .into());
            }
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            if self.is_installed() {
                return Ok(());
            }
            let output = std::process::Command::new("certutil")
                .args(["-user", "-addstore", "ROOT"])
                .arg(&self.cert_path)
                .creation_flags(0x0800_0000)
                .output()?;
            if !output.status.success() {
                return Err(format!(
                    "certutil failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )
                .into());
            }
            Ok(())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err("automatic CA installation is unsupported on this platform; export the certificate and install it with your distribution's trust tooling".into())
        }
    }

    pub fn uninstall_from_system(&self) -> crate::state::BoxResult<()> {
        #[cfg(target_os = "macos")]
        {
            let fingerprint = self.fingerprint()?;
            if self.present_in_keychain(Some("/Library/Keychains/System.keychain"))? {
                if self.is_installed() {
                    let output = std::process::Command::new("security")
                        .args(["remove-trusted-cert", "-d"])
                        .arg(&self.cert_path)
                        .output()?;
                    if !output.status.success() {
                        return Err(format!(
                            "removing this session's CA trust failed: {}",
                            String::from_utf8_lossy(&output.stderr).trim()
                        )
                        .into());
                    }
                }
                let script = format!("do shell script \"security delete-certificate -Z {fingerprint} /Library/Keychains/System.keychain\" with administrator privileges");
                let output = std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output()?;
                if !output.status.success() {
                    return Err(format!(
                        "removing this session's CA failed: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    )
                    .into());
                }
            }
            // Older desktop versions used the login keychain. Remove only the same fingerprint.
            if self.present_in_keychain(None)? {
                let trust = std::process::Command::new("security")
                    .arg("remove-trusted-cert")
                    .arg(&self.cert_path)
                    .output()?;
                if !trust.status.success() {
                    return Err(format!(
                        "removing this session's user trust failed: {}",
                        String::from_utf8_lossy(&trust.stderr).trim()
                    )
                    .into());
                }
                let output = std::process::Command::new("security")
                    .args(["delete-certificate", "-Z", &fingerprint])
                    .output()?;
                if !output.status.success() {
                    return Err(format!(
                        "removing this session's login CA failed: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    )
                    .into());
                }
            }
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            if !self.is_installed() {
                return Ok(());
            }
            let fingerprint = self.fingerprint()?;
            let output = std::process::Command::new("certutil")
                .args(["-user", "-delstore", "ROOT", &fingerprint])
                .creation_flags(0x0800_0000)
                .output()?;
            if !output.status.success() {
                return Err(format!(
                    "removing this session's CA failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )
                .into());
            }
            Ok(())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err("automatic CA removal is unsupported on this platform; use your distribution's trust tooling".into())
        }
    }

    pub fn is_installed(&self) -> bool {
        self.system_trust().ok().flatten().unwrap_or(false)
    }
}

/// Host-specific interception certificates with strict-client compatible extensions.
pub struct MitmAuthority {
    signer: std::sync::Arc<LeafSigner>,
    cache: moka::future::Cache<String, std::sync::Arc<hudsucker::rustls::ServerConfig>>,
    rejecting: std::sync::Arc<hudsucker::rustls::ServerConfig>,
}

struct LeafSigner {
    key: KeyPair,
    certificate: rcgen::Certificate,
}

#[derive(Debug)]
struct RejectCertificates;
impl hudsucker::rustls::server::ResolvesServerCert for RejectCertificates {
    fn resolve(
        &self,
        _: hudsucker::rustls::server::ClientHello<'_>,
    ) -> Option<std::sync::Arc<hudsucker::rustls::sign::CertifiedKey>> {
        None
    }
}

impl MitmAuthority {
    pub fn new(root: &CertAuthority) -> crate::state::BoxResult<Self> {
        use hudsucker::rustls;
        use std::sync::Arc;
        let key = KeyPair::from_pem(&root.key_pem)?;
        let certificate = CertificateParams::from_ca_cert_pem(&root.cert_pem)?.self_signed(&key)?;
        let rejecting = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(RejectCertificates));
        Ok(Self {
            signer: Arc::new(LeafSigner { key, certificate }),
            cache: moka::future::Cache::builder()
                .max_capacity(1000)
                .time_to_live(std::time::Duration::from_secs(12 * 60 * 60))
                .build(),
            rejecting: Arc::new(rejecting),
        })
    }
    fn hostname(authority: &http::uri::Authority) -> Result<String, String> {
        let raw = authority.host();
        let host = raw
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(raw);
        // Validation happens before rcgen; malformed network input never reaches an expect/panic.
        hudsucker::rustls::pki_types::ServerName::try_from(host.to_owned())
            .map_err(|e| e.to_string())?;
        Ok(host.to_ascii_lowercase())
    }
}

impl LeafSigner {
    fn certificate(&self, host: &str) -> crate::state::BoxResult<(rcgen::Certificate, KeyPair)> {
        let mut params = CertificateParams::new(vec![host.to_owned()])?;
        let now = time::OffsetDateTime::now_utc();
        params.not_before =
            (now - time::Duration::seconds(60)).max(self.certificate.params().not_before);
        params.not_after =
            (now + time::Duration::days(30)).min(self.certificate.params().not_after);
        if params.not_after <= now {
            return Err("the session CA has expired".into());
        }
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, host);
        params.use_authority_key_identifier_extension = true;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        // Leaf keys are never the signing CA private key, even across cache eviction.
        let leaf_key = KeyPair::generate()?;
        let certificate = params.signed_by(&leaf_key, &self.certificate, &self.key)?;
        Ok((certificate, leaf_key))
    }
    fn server_config(
        &self,
        host: &str,
    ) -> crate::state::BoxResult<std::sync::Arc<hudsucker::rustls::ServerConfig>> {
        use hudsucker::rustls::{
            self,
            pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
        };
        use std::sync::Arc;
        let (certificate, key) = self.certificate(host)?;
        let key = PrivateKeyDer::from(PrivatePkcs8KeyDer::from(key.serialize_der()));
        let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(vec![certificate.der().clone()], key)?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(config))
    }
}

impl hudsucker::certificate_authority::CertificateAuthority for MitmAuthority {
    async fn gen_server_config(
        &self,
        authority: &http::uri::Authority,
    ) -> std::sync::Arc<hudsucker::rustls::ServerConfig> {
        let host = match Self::hostname(authority) {
            Ok(host) => host,
            Err(error) => {
                tracing::warn!("rejecting invalid CONNECT authority: {error}");
                return self.rejecting.clone();
            }
        };
        let signer = self.signer.clone();
        match self
            .cache
            .try_get_with(host.clone(), async move {
                tokio::task::spawn_blocking(move || {
                    signer.server_config(&host).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())?
            })
            .await
        {
            Ok(config) => config,
            Err(error) => {
                tracing::error!("cannot issue interception certificate: {error}");
                self.rejecting.clone()
            }
        }
    }
}

#[cfg(test)]
mod certificate_tests {
    use super::*;
    use x509_parser::{
        extensions::{GeneralName, ParsedExtension},
        prelude::*,
    };

    #[test]
    fn read_only_probe_preserves_absent_partial_and_mismatched_material() {
        let directory = tempfile::tempdir().unwrap();
        assert!(CertAuthority::load_existing(directory.path())
            .unwrap()
            .is_none());
        assert!(!directory.path().join("ca").exists());
        let original = CertAuthority::load_or_create(directory.path()).unwrap();
        let key_path = directory.path().join("ca/tucano-root.key.pem");
        fs::remove_file(&key_path).unwrap();
        assert!(CertAuthority::load_existing(directory.path()).is_err());
        assert_eq!(
            fs::read_to_string(&original.cert_path).unwrap(),
            original.cert_pem
        );
        assert!(!key_path.exists());
        let other = tempfile::tempdir().unwrap();
        let other_ca = CertAuthority::load_or_create(other.path()).unwrap();
        fs::write(&key_path, &other_ca.key_pem).unwrap();
        assert!(CertAuthority::load_existing(directory.path()).is_err());
        assert_eq!(fs::read_to_string(&key_path).unwrap(), other_ca.key_pem);
        fs::write(&key_path, &original.key_pem).unwrap();
        assert_eq!(
            CertAuthority::load_existing(directory.path())
                .unwrap()
                .unwrap()
                .cert_pem,
            original.cert_pem
        );
    }

    #[test]
    fn leaf_has_matching_authority_key_id_distinct_key_and_dns_ip_sans() {
        let dir = tempfile::tempdir().unwrap();
        let root = CertAuthority::load_or_create(dir.path()).unwrap();
        let authority = MitmAuthority::new(&root).unwrap();
        let root_der = authority.signer.certificate.der();
        let (_, root_cert) = parse_x509_certificate(root_der).unwrap();
        let root_key_id = root_cert
            .iter_extensions()
            .find_map(|extension| match extension.parsed_extension() {
                ParsedExtension::SubjectKeyIdentifier(id) => Some(id.0),
                _ => None,
            })
            .unwrap();
        for (input, host) in [
            ("example.test:443", "example.test"),
            ("127.0.0.1:443", "127.0.0.1"),
            ("[::1]:443", "::1"),
        ] {
            let parsed: http::uri::Authority = input.parse().unwrap();
            assert_eq!(MitmAuthority::hostname(&parsed).unwrap(), host);
            let (leaf, _) = authority.signer.certificate(host).unwrap();
            let (_, cert) = parse_x509_certificate(leaf.der()).unwrap();
            let aki = cert
                .iter_extensions()
                .find_map(|extension| match extension.parsed_extension() {
                    ParsedExtension::AuthorityKeyIdentifier(id) => {
                        id.key_identifier.as_ref().map(|id| id.0)
                    }
                    _ => None,
                })
                .unwrap();
            assert_eq!(aki, root_key_id);
            assert_ne!(cert.public_key().raw, root_cert.public_key().raw);
            assert!(
                cert.extended_key_usage()
                    .unwrap()
                    .unwrap()
                    .value
                    .server_auth
            );
            let names = &cert
                .subject_alternative_name()
                .unwrap()
                .unwrap()
                .value
                .general_names;
            match host.parse::<std::net::IpAddr>() {
                Ok(std::net::IpAddr::V4(ip)) => assert!(names.iter().any(
                    |name| matches!(name, GeneralName::IPAddress(bytes) if *bytes == ip.octets())
                )),
                Ok(std::net::IpAddr::V6(ip)) => assert!(names.iter().any(
                    |name| matches!(name, GeneralName::IPAddress(bytes) if *bytes == ip.octets())
                )),
                Err(_) => assert!(names
                    .iter()
                    .any(|name| matches!(name, GeneralName::DNSName(name) if *name == host))),
            }
        }
    }
}
