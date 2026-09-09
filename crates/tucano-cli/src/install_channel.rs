use anyhow::Result;
use serde::Deserialize;
use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{self, Read},
    path::Path,
};

const MARKER: &str = ".tucano-proxy-install.json";
const MAX_MARKER: u64 = 4096;

#[derive(Clone, Copy, Debug)]
pub(super) enum Channel {
    Npm,
    Homebrew,
    Winget,
}

impl Channel {
    fn name(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Homebrew => "homebrew",
            Self::Winget => "winget",
        }
    }

    fn package(self) -> &'static str {
        match self {
            Self::Npm => "tucano-proxy",
            Self::Homebrew => "plscabral/tap/tucano-proxy",
            Self::Winget => "PauloCabral.TucanoProxy.CLI",
        }
    }

    fn command(self) -> &'static str {
        match self {
            Self::Npm => "npm install -g tucano-proxy@latest",
            Self::Homebrew => "brew upgrade plscabral/tap/tucano-proxy",
            Self::Winget => "winget upgrade --id PauloCabral.TucanoProxy.CLI --exact",
        }
    }
}

pub(super) enum Installation {
    Standalone,
    Managed(Channel),
    Unknown(String),
}

impl Installation {
    pub(super) fn channel(&self) -> &'static str {
        match self {
            Self::Standalone => "standalone",
            Self::Managed(channel) => channel.name(),
            Self::Unknown(_) => "unknown",
        }
    }

    pub(super) fn package(&self) -> Option<&'static str> {
        match self {
            Self::Managed(channel) => Some(channel.package()),
            _ => None,
        }
    }

    pub(super) fn update_command(&self) -> Option<&'static str> {
        match self {
            Self::Standalone => Some("tucano-proxy update"),
            Self::Managed(channel) => Some(channel.command()),
            Self::Unknown(_) => None,
        }
    }

    pub(super) fn error(&self) -> Option<&str> {
        match self {
            Self::Unknown(error) => Some(error),
            _ => None,
        }
    }

    pub(super) fn self_update_allowed(&self) -> bool {
        matches!(self, Self::Standalone)
    }

    pub(super) fn ensure_mutation_allowed(&self) -> Result<()> {
        match self {
            Self::Standalone => Ok(()),
            Self::Managed(channel) => Err(crate::client::fail(
                "managed_installation",
                format!(
                    "This installation is managed by {} and cannot self-update. Run `{}` instead. Use `tucano-proxy update --check` for a read-only release check.",
                    channel.name(),
                    channel.command()
                ),
                7,
            )),
            Self::Unknown(error) => Err(crate::client::fail(
                "installation_ownership_unknown",
                format!(
                    "Cannot safely self-update: {error}. Repair or reinstall using the original installation method before updating. Use `tucano-proxy update --check` for a read-only release check."
                ),
                7,
            )),
        }
    }
}

#[derive(Deserialize)]
struct Marker {
    channel: String,
    package: String,
}

pub(super) fn detect() -> Installation {
    match std::env::current_exe() {
        Ok(executable) => detect_at(
            &executable,
            std::env::var_os("TUCANO_INSTALL_CHANNEL").as_deref() == Some(OsStr::new("npm")),
        ),
        Err(error) => {
            Installation::Unknown(format!("Cannot locate the running executable: {error}"))
        }
    }
}

fn detect_at(executable: &Path, npm_hint: bool) -> Installation {
    let executable = match executable.canonicalize() {
        Ok(executable) => executable,
        Err(error) => {
            return Installation::Unknown(format!(
                "Cannot resolve the running executable: {error}"
            ));
        }
    };
    let Some(directory) = executable.parent() else {
        return Installation::Unknown("The running executable has no parent directory".into());
    };
    let marker = directory.join(MARKER);
    match File::open(&marker) {
        Ok(file) => {
            let mut bytes = Vec::new();
            if let Err(error) = file.take(MAX_MARKER + 1).read_to_end(&mut bytes) {
                return Installation::Unknown(format!("Cannot read {}: {error}", marker.display()));
            }
            if bytes.len() as u64 > MAX_MARKER {
                return Installation::Unknown(format!(
                    "Installation marker {} is too large",
                    marker.display()
                ));
            }
            let parsed = serde_json::from_slice::<Marker>(&bytes);
            let channel = match parsed {
                Ok(parsed) => {
                    let channel = match parsed.channel.as_str() {
                        "npm" => Some(Channel::Npm),
                        "homebrew" => Some(Channel::Homebrew),
                        "winget" => Some(Channel::Winget),
                        _ => None,
                    };
                    channel.filter(|channel| parsed.package == channel.package())
                }
                Err(_) => None,
            };
            return match channel {
                Some(channel) => Installation::Managed(channel),
                None => Installation::Unknown(format!(
                    "Installation marker {} is malformed or names an unknown channel/package",
                    marker.display()
                )),
            };
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A dangling marker symlink is still an existing, unreadable ownership claim.
            match fs::symlink_metadata(&marker) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                _ => {
                    return Installation::Unknown(format!(
                        "Cannot read installation marker {}",
                        marker.display()
                    ))
                }
            }
        }
        Err(error) => {
            return Installation::Unknown(format!("Cannot read {}: {error}", marker.display()));
        }
    }
    if npm_hint {
        return Installation::Managed(Channel::Npm);
    }
    if is_homebrew_path(&executable) {
        return Installation::Managed(Channel::Homebrew);
    }
    #[cfg(windows)]
    if is_winget_path(&executable.to_string_lossy()) {
        return Installation::Managed(Channel::Winget);
    }
    Installation::Standalone
}

fn is_homebrew_path(executable: &Path) -> bool {
    if executable.file_name() != Some(OsStr::new("tucano-proxy")) {
        return false;
    }
    let Some(bin) = executable.parent() else {
        return false;
    };
    let Some(version) = bin.parent() else {
        return false;
    };
    let Some(formula) = version.parent() else {
        return false;
    };
    let Some(cellar) = formula.parent() else {
        return false;
    };
    bin.file_name() == Some(OsStr::new("bin"))
        && formula.file_name() == Some(OsStr::new("tucano-proxy"))
        && cellar.file_name() == Some(OsStr::new("Cellar"))
}

#[cfg(any(windows, test))]
fn is_winget_path(executable: &str) -> bool {
    let mut components = executable.rsplit(['\\', '/']);
    if !components
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("tucano-proxy.exe"))
    {
        return false;
    }
    // WinGet supports relocated package roots. The CLI-specific package directory,
    // not a generic "WinGet" or "Packages" ancestor, establishes ownership.
    components.any(|directory| {
        directory.split_once('_').is_some_and(|(package, source)| {
            package.eq_ignore_ascii_case("PauloCabral.TucanoProxy.CLI")
                && !source.is_empty()
                && source
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn executable(directory: &Path) -> std::path::PathBuf {
        fs::create_dir_all(directory).unwrap();
        let executable = directory.join("tucano-proxy");
        fs::write(&executable, b"installed binary").unwrap();
        executable
    }

    #[test]
    fn ownership_controls_mutation_without_relying_on_wrapper_environment() {
        let temp = tempfile::tempdir().unwrap();
        let executable = executable(temp.path());
        assert!(detect_at(&executable, false)
            .ensure_mutation_allowed()
            .is_ok());
        for channel in [Channel::Npm, Channel::Homebrew, Channel::Winget] {
            fs::write(temp.path().join(MARKER), serde_json::to_vec(&serde_json::json!({
                "channel": channel.name(), "package": channel.package(), "updateCommand": "untrusted command"
            })).unwrap()).unwrap();
            let installation = detect_at(&executable, false);
            let error = installation.ensure_mutation_allowed().unwrap_err();
            assert_eq!(
                error.downcast_ref::<crate::client::Failure>().unwrap().code,
                "managed_installation"
            );
            assert!(error.to_string().contains(channel.command()));
            assert!(!error.to_string().contains("untrusted command"));
        }
        fs::remove_file(temp.path().join(MARKER)).unwrap();
        assert!(detect_at(&executable, true)
            .ensure_mutation_allowed()
            .is_err());
        assert!(detect_at(&executable, false)
            .ensure_mutation_allowed()
            .is_ok());
    }

    #[test]
    fn unreadable_or_unknown_marker_never_becomes_standalone() {
        let temp = tempfile::tempdir().unwrap();
        let executable = executable(temp.path());
        let marker = temp.path().join(MARKER);
        for bytes in [
            b"{".as_slice(),
            br#"{"channel":"other","package":"tucano-proxy"}"#,
            br#"{"channel":"npm","package":"other"}"#,
        ] {
            fs::write(&marker, bytes).unwrap();
            let installation = detect_at(&executable, true);
            let error = installation.ensure_mutation_allowed().unwrap_err();
            assert_eq!(
                error.downcast_ref::<crate::client::Failure>().unwrap().code,
                "installation_ownership_unknown"
            );
            assert_eq!(installation.channel(), "unknown");
            assert_eq!(installation.update_command(), None);
        }
        fs::remove_file(&marker).unwrap();
        fs::create_dir(&marker).unwrap();
        assert!(detect_at(&executable, false)
            .ensure_mutation_allowed()
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_launcher_uses_real_executable_marker() {
        let temp = tempfile::tempdir().unwrap();
        let executable = executable(&temp.path().join("package"));
        fs::write(
            executable.parent().unwrap().join(MARKER),
            br#"{"channel":"npm","package":"tucano-proxy"}"#,
        )
        .unwrap();
        let launcher = temp.path().join("launcher");
        std::os::unix::fs::symlink(&executable, &launcher).unwrap();
        assert_eq!(detect_at(&launcher, false).channel(), "npm");
        fs::remove_file(executable.parent().unwrap().join(MARKER)).unwrap();
        std::os::unix::fs::symlink("missing-marker", executable.parent().unwrap().join(MARKER))
            .unwrap();
        assert!(detect_at(&launcher, false)
            .ensure_mutation_allowed()
            .is_err());
    }

    #[test]
    fn package_paths_require_cli_specific_layouts() {
        let temp = tempfile::tempdir().unwrap();
        let brew = executable(&temp.path().join("Cellar/tucano-proxy/0.2.7/bin"));
        assert_eq!(detect_at(&brew, false).channel(), "homebrew");
        let unrelated = executable(&temp.path().join("Cellar/other/0.2.7/bin"));
        assert!(detect_at(&unrelated, false)
            .ensure_mutation_allowed()
            .is_ok());
        let root = r"C:\Users\alice\AppData\Local\Microsoft\WinGet\Packages";
        for path in [
            format!(
                r"\\?\{root}\PauloCabral.TucanoProxy.CLI_Microsoft.Winget.Source_8wekyb3d8bbwe\tucano-proxy.exe"
            ),
            r"C:\Program Files\WinGet\Packages\PauloCabral.TucanoProxy.CLI_source\tucano-proxy.exe"
                .into(),
            r"D:\custom\PauloCabral.TucanoProxy.CLI_source\bin\tucano-proxy.exe".into(),
        ] {
            assert!(is_winget_path(&path), "{path}");
        }
        for path in [
            format!(
                r"{root}\PauloCabral.TucanoProxy_Microsoft.Winget.Source_8wekyb3d8bbwe\tucano-proxy.exe"
            ),
            format!(r"{root}\PauloCabral.TucanoProxy.CLI_\tucano-proxy.exe"),
            format!(r"{root}\OtherPauloCabral.TucanoProxy.CLI_source\tucano-proxy.exe"),
            format!(r"{root}\PauloCabral.TucanoProxy.CLI_source\other.exe"),
            r"C:\work\WinGet\Packages\tucano-proxy.exe".into(),
        ] {
            assert!(!is_winget_path(&path), "{path}");
        }
    }
}
