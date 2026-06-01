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
            // This is split into two operations on purpose. The naive
            // `add-trusted-cert -k /Library/Keychains/System.keychain` does
            // BOTH a root-owned keychain write AND a trust-settings write in one
            // call, and that only works from a code-signed app that the Security
            // framework lets present the native authorization prompt. From an
            // unsigned / `tauri dev` binary the prompt never appears and it
            // fails instantly with "SecCertificateAddToKeychain: Write
            // permissions error" — install silently does nothing. The two
            // sub-operations also have *opposite* elevation requirements, so
            // neither plain-direct nor osascript-admin works for both at once:
            //
            //   • Writing the cert into the System keychain needs root, and does
            //     NOT prompt on its own. We run it via osascript-admin, which
            //     shows macOS's own password dialog and performs the write as
            //     root — works regardless of code signing.
            //   • Setting the admin-domain trust must NOT run as root: as root
            //     SecTrustSettingsSetTrustSettings fails with "authorization
            //     denied since no user interaction was possible". Run directly
            //     as the user, with the cert already in the keychain, it
            //     succeeds with no prompt at all.
            //
            // First, evict any stale copy from the user's login keychain. Builds
            // before v0.2.2 installed the CA there; that old copy survives an
            // upgrade and confuses the trust step. User-owned, so no prompt;
            // ignore the result (nothing to remove on a clean machine).
            let _ = std::process::Command::new("security")
                .args(["delete-certificate", "-c", "Tucano Root CA"])
                .status();

            // Step 1: add the cert to the System keychain as root.
            let cert = self.cert_path.to_string_lossy();
            let inner = format!(
                "security add-certificates -k /Library/Keychains/System.keychain '{}'",
                cert
            );
            let script = format!(
                "do shell script \"{}\" with administrator privileges",
                inner.replace('\\', "\\\\").replace('"', "\\\"")
            );
            let added = std::process::Command::new("osascript")
                .args(["-e", &script])
                .status()?;
            if !added.success() {
                return Err("adding the CA to the System keychain failed (cancelled or no admin rights)".into());
            }

            // Step 2: set admin-domain trust for ALL policies (note: no `-p`).
            // No `-k`: the cert is already in the System keychain, so this only
            // writes the trust setting — directly, as the user, no prompt.
            //
            // Why admin domain / all policies? Browsers honor user-domain,
            // SSL-scoped trust, so the old login-keychain `-p ssl` approach
            // *looked* fine. But the .NET chain builder on macOS only consults
            // the admin trust domain and evaluates the anchor under a generic
            // policy, so login-keychain SSL-only trust is invisible to it and
            // every HTTPS call fails with `UntrustedRoot`. Trusting for all
            // policies in the admin domain fixes .NET (and Java, etc.) while
            // still working for browsers.
            let status = std::process::Command::new("security")
                .args(["add-trusted-cert", "-d", "-r", "trustRoot"])
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
            // macOS splits this into two operations with DIFFERENT auth rules:
            //
            // 1. Trust settings (SecTrustSettings*). `remove-trusted-cert -d`
            //    is the exact inverse of install's `add-trusted-cert -d`. It
            //    needs *interactive* authorization and must NOT run as root:
            //    under `osascript ... with administrator privileges` it fails
            //    with "authorization denied since no user interaction was
            //    possible". So we call it DIRECTLY, exactly like the trust step
            //    of install — the Security framework shows the native prompt.
            //    This is what `is_installed` keys off of (dump-trust-settings).
            //
            // 2. Evicting the cert from the root-owned System keychain. This
            //    needs write access (root) and, unlike add-trusted-cert, does
            //    NOT pop its own prompt — a plain `delete-certificate` just
            //    fails with "Write permissions error". So we run it via
            //    osascript-admin (as root), which DOES work for a pure keychain
            //    write. Leaving an orphaned cert here is not cosmetic: a later
            //    install's `add-trusted-cert` chokes on the pre-existing cert
            //    ("SecCertificateAddToKeychain: Write permissions error") and
            //    silently fails, so the cert MUST be removed for reinstall.
            let status = std::process::Command::new("security")
                .args(["remove-trusted-cert", "-d"])
                .arg(&self.cert_path)
                .status()?;
            if !status.success() {
                return Err("security remove-trusted-cert failed".into());
            }
            let del = std::process::Command::new("osascript")
                .args([
                    "-e",
                    "do shell script \"security delete-certificate -c 'Tucano Root CA' /Library/Keychains/System.keychain\" with administrator privileges",
                ])
                .status()?;
            if !del.success() {
                return Err("security delete-certificate failed".into());
            }
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
