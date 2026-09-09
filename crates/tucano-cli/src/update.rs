use anyhow::{bail, ensure, Context, Result};
use semver::Version;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, IsTerminal, Read, Write},
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;

#[path = "install_channel.rs"]
mod install_channel;

const RELEASE_API: &str = "https://api.github.com/repos/plscabral/tucano-proxy/releases/latest";
const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_UNPACKED: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;
const SERVICE_NOTICE: &str = "Session data, certificates and configuration are unchanged. Running services keep their old version; stop and start each session manually when ready. No service was stopped or restarted.";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
}

fn target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "aarch64") if cfg!(target_env = "gnu") => Some("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") if cfg!(target_env = "gnu") => Some("x86_64-unknown-linux-gnu"),
        ("windows", "x86_64") if cfg!(target_env = "msvc") => Some("x86_64-pc-windows-msvc"),
        _ => None,
    }
}

fn asset_name(target: &str) -> String {
    let extension = if target.ends_with("windows-msvc") {
        "zip"
    } else {
        "tar.gz"
    };
    format!("tucano-proxy-{target}.{extension}")
}

fn version(tag: &str) -> Result<Version> {
    Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .context("Release tag is not a semantic version")
}

fn selected_asset<'a>(release: &'a Release, name: &str) -> Result<Option<&'a Asset>> {
    let mut assets = release.assets.iter().filter(|asset| asset.name == name);
    let asset = assets.next();
    ensure!(
        assets.next().is_none(),
        "Release contains duplicate asset {name}"
    );
    if let Some(asset) = asset {
        let expected = format!(
            "https://github.com/plscabral/tucano-proxy/releases/download/{}/{name}",
            release.tag_name
        );
        ensure!(
            asset.browser_download_url == expected,
            "Unexpected release asset URL for {name}"
        );
    }
    Ok(asset)
}

fn http_client(timeout: u64) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("tucano-proxy/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .connect_timeout(Duration::from_secs(timeout.clamp(1, 30)))
        .timeout(Duration::from_secs(timeout.clamp(1, 300)))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?)
}

async fn download(
    http: &reqwest::Client,
    url: &str,
    limit: u64,
    mut destination: impl Write,
) -> Result<u64> {
    let mut response = http
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .context("Could not reach official GitHub Releases")?
        .error_for_status()
        .context("GitHub release request failed (check connectivity or API rate limits)")?;
    ensure!(
        response.content_length().is_none_or(|size| size <= limit),
        "Release download exceeds size limit"
    );
    let mut count = 0;
    while let Some(chunk) = response.chunk().await? {
        count += chunk.len() as u64;
        ensure!(count <= limit, "Release download exceeds size limit");
        destination.write_all(&chunk)?;
    }
    Ok(count)
}

pub async fn run(check_only: bool, yes: bool, json_mode: bool, timeout: u64) -> Result<Value> {
    let installation = install_channel::detect();
    if !check_only {
        installation.ensure_mutation_allowed()?;
    }
    let http = http_client(timeout)?;
    let mut metadata = Vec::new();
    download(&http, RELEASE_API, 2 * 1024 * 1024, &mut metadata).await?;
    let release: Release =
        serde_json::from_slice(&metadata).context("Invalid GitHub release metadata")?;
    ensure!(
        !release.draft && !release.prerelease,
        "Latest release is not a stable published release"
    );
    let installed = version(env!("CARGO_PKG_VERSION"))?;
    let latest = version(&release.tag_name)?;
    ensure!(
        latest.pre.is_empty(),
        "Latest release has a prerelease version"
    );
    let newer = latest.cmp_precedence(&installed).is_gt();
    let platform = target();
    let name = platform.map(asset_name);
    let archive = name
        .as_deref()
        .map(|name| selected_asset(&release, name))
        .transpose()?
        .flatten();
    let checksum = name
        .as_ref()
        .map(|name| selected_asset(&release, &format!("{name}.sha256")))
        .transpose()?
        .flatten();
    let available = archive.is_some() && checksum.is_some();
    let status = if platform.is_none() {
        "unsupported_platform"
    } else if !available {
        "cli_asset_unavailable"
    } else if newer {
        "update_available"
    } else if latest.cmp_precedence(&installed).is_lt() {
        "installed_newer"
    } else {
        "up_to_date"
    };
    let mut result = json!({
        "installedVersion": installed.to_string(), "latestVersion": latest.to_string(),
        "releaseTag": release.tag_name,
        "releaseUrl": format!("https://github.com/plscabral/tucano-proxy/releases/tag/{}", release.tag_name),
        "target": platform, "asset": name, "archiveAvailable": archive.is_some(),
        "checksumAvailable": checksum.is_some(), "assetAvailable": available,
        "newerVersionAvailable": newer, "updateAvailable": newer && available,
        "checkOnly": check_only, "updated": false, "status": status,
        "installChannel": installation.channel(), "installPackage": installation.package(),
        "updateCommand": installation.update_command(),
        "selfUpdateAllowed": installation.self_update_allowed(),
        "installationError": installation.error(),
    });
    if !json_mode {
        println!("Tucano Proxy update\n  Installed: {installed}\n  Latest:    {latest}");
        println!("  Platform:  {}", platform.unwrap_or("unsupported"));
        println!("  Channel:   {}", installation.channel());
        if !available {
            println!("The latest release does not include a standalone CLI archive and checksum for this platform. Desktop installers are not CLI updates.");
        } else if !newer {
            println!("No upgrade is needed; the installed version is the same or newer.");
        } else if installation.self_update_allowed() {
            println!("A standalone CLI update is available.");
        }
        if !installation.self_update_allowed() {
            if let Some(command) = installation.update_command() {
                println!("This installation is package-managed. To upgrade, run `{command}`.");
            } else if let Some(error) = installation.error() {
                println!("Self-update is disabled: {error}. Repair or reinstall using the original installation method.");
            }
        }
    }
    if check_only || !newer || !available {
        return Ok(result);
    }
    if !yes {
        if json_mode || !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            return Err(crate::client::fail("confirmation_required", "Update requires --yes in JSON or non-interactive mode. Use update --check for a read-only check.", 7));
        }
        let executable = std::env::current_exe()?;
        print!(
            "Replace {} with version {latest}? [y/N] ",
            executable.display()
        );
        io::stdout().flush()?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer)?;
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            result["status"] = json!("cancelled");
            println!("Update cancelled; nothing changed.");
            return Ok(result);
        }
    }
    let archive = archive.context("Missing CLI archive")?;
    let checksum = checksum.context("Missing CLI checksum")?;
    ensure!(
        archive.size > 0 && archive.size <= MAX_ARCHIVE,
        "Invalid archive size in release metadata"
    );
    ensure!(
        checksum.size > 0 && checksum.size <= 4096,
        "Invalid checksum size in release metadata"
    );
    let staging = tempfile::tempdir().context("Could not create private update directory")?;
    let archive_path = staging.path().join(&archive.name);
    let mut archive_file = File::create(&archive_path)?;
    let mut checksum_bytes = Vec::new();
    download(
        &http,
        &checksum.browser_download_url,
        4096,
        &mut checksum_bytes,
    )
    .await?;
    let downloaded = download(
        &http,
        &archive.browser_download_url,
        MAX_ARCHIVE,
        &mut archive_file,
    )
    .await?;
    ensure!(
        downloaded == archive.size,
        "Archive size does not match release metadata"
    );
    archive_file.sync_all()?;
    drop(archive_file);
    apply_candidate(
        &archive_path,
        &checksum_bytes,
        &archive.name,
        &latest,
        timeout,
        |binary| {
            // Ownership may have changed while the release was downloading.
            install_channel::detect().ensure_mutation_allowed()?;
            self_replace::self_replace(binary).context(
                "Could not replace the executable; check installation directory permissions",
            )
        },
    )
    .await?;
    result["updated"] = json!(true);
    result["status"] = json!("updated");
    result["installedVersion"] = json!(latest.to_string());
    result["previousVersion"] = json!(installed.to_string());
    result["serviceNotice"] = json!(SERVICE_NOTICE);
    if !json_mode {
        println!("Updated to Tucano Proxy {latest}.\n{SERVICE_NOTICE}");
    }
    Ok(result)
}

fn verify_checksum(archive: &Path, checksum: &[u8], name: &str) -> Result<()> {
    let text = std::str::from_utf8(checksum).context("Checksum is not UTF-8")?;
    let fields: Vec<_> = text.split_whitespace().collect();
    ensure!(
        fields.len() == 2 && fields[1].trim_start_matches('*') == name,
        "Checksum must name the selected archive exactly once"
    );
    let expected = fields[0];
    ensure!(
        expected.len() == 64 && expected.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid SHA-256 checksum"
    );
    let mut input = File::open(archive)?;
    ensure!(
        input.metadata()?.len() <= MAX_ARCHIVE,
        "Archive exceeds size limit"
    );
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    ensure!(
        format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected),
        "SHA-256 mismatch; installed executable was not changed"
    );
    Ok(())
}

fn safe_member(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && !name.contains(['\\', ':', '\0'])
            && !name.starts_with('/')
            && name
                .trim_end_matches('/')
                .split('/')
                .all(|part| !matches!(part, "" | "." | "..")),
        "Unsafe archive member path"
    );
    Ok(())
}

fn copy_executable(mut input: impl Read, size: u64, destination: &Path) -> Result<()> {
    ensure!(
        size > 0 && size <= MAX_ARCHIVE,
        "Executable exceeds size limit or is empty"
    );
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let copied = io::copy(&mut input.by_ref().take(size + 1), &mut file)?;
    ensure!(
        copied == size,
        "Executable size does not match archive header"
    );
    file.sync_all()?;
    Ok(())
}

fn extract_executable(archive: &Path, name: &str, destination: &Path) -> Result<()> {
    let mut found = false;
    if name.ends_with(".tar.gz") {
        let reader = flate2::read::GzDecoder::new(File::open(archive)?).take(MAX_UNPACKED);
        let mut archive = tar::Archive::new(reader);
        for (index, entry) in archive.entries()?.enumerate() {
            ensure!(index < MAX_ENTRIES, "Archive has too many members");
            let mut entry = entry?;
            let path = entry.path_bytes();
            let path = std::str::from_utf8(&path).context("Archive path is not UTF-8")?;
            safe_member(path)?;
            let kind = entry.header().entry_type();
            ensure!(
                kind.is_file() || kind.is_dir(),
                "Archive contains a link or non-regular member"
            );
            if path == "tucano-proxy" {
                ensure!(
                    kind.is_file() && !found,
                    "Archive must contain exactly one regular executable"
                );
                found = true;
                let size = entry.size();
                copy_executable(&mut entry, size, destination)?;
            }
        }
        ensure!(
            archive.into_inner().limit() > 0,
            "Expanded archive exceeds size limit"
        );
    } else if name.ends_with(".zip") {
        let mut archive = zip::ZipArchive::new(File::open(archive)?)?;
        ensure!(archive.len() <= MAX_ENTRIES, "Archive has too many members");
        let mut total = 0u64;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            safe_member(entry.name())?;
            let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
            ensure!(
                !entry.is_symlink() && matches!(kind, 0 | 0o100000 | 0o040000),
                "Archive contains a link or non-regular member"
            );
            total = total
                .checked_add(entry.size())
                .context("Archive size overflow")?;
            ensure!(total <= MAX_UNPACKED, "Expanded archive exceeds size limit");
            if entry.name() == "tucano-proxy.exe" {
                ensure!(
                    entry.is_file() && matches!(kind, 0 | 0o100000) && !found,
                    "Archive must contain exactly one regular executable"
                );
                found = true;
                let size = entry.size();
                copy_executable(&mut entry, size, destination)?;
            }
        }
    } else {
        bail!("Unsupported CLI archive format");
    }
    ensure!(found, "Archive is missing the expected executable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

async fn validate_executable(binary: &Path, expected: &Version, timeout: u64) -> Result<()> {
    let mut child = tokio::process::Command::new(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("Downloaded executable cannot run on this platform")?;
    let mut stdout = child
        .stdout
        .take()
        .context("Missing version output pipe")?
        .take(4097);
    let check = async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        ensure!(
            bytes.len() <= 4096,
            "Downloaded executable returned excessive version output"
        );
        ensure!(
            child.wait().await?.success(),
            "Downloaded executable version check failed"
        );
        let text = std::str::from_utf8(&bytes).context("Invalid executable version output")?;
        let actual = text
            .trim()
            .strip_prefix("tucano-proxy ")
            .context("Downloaded executable is not Tucano Proxy CLI")?;
        ensure!(
            Version::parse(actual)? == *expected,
            "Downloaded executable version does not match release tag"
        );
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(timeout.clamp(1, 15)), check)
        .await
        .context("Downloaded executable version check timed out")?
}

// The replacement boundary is injectable for local fixtures, never a CLI URL or destination override.
// Production passes only self_replace; tests can target disposable files without touching the running binary.
pub(crate) async fn apply_candidate(
    archive: &Path,
    checksum: &[u8],
    name: &str,
    expected: &Version,
    timeout: u64,
    replace: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    verify_checksum(archive, checksum, name)?;
    let staging = tempfile::tempdir()?;
    let binary = staging.path().join(if name.ends_with(".zip") {
        "tucano-proxy.exe"
    } else {
        "tucano-proxy"
    });
    extract_executable(archive, name, &binary)?;
    validate_executable(&binary, expected, timeout).await?;
    replace(&binary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tar_fixture(path: &Path, members: &[(&str, &[u8], tar::EntryType)]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(
            File::create(path).unwrap(),
            flate2::Compression::default(),
        );
        let mut archive = tar::Builder::new(encoder);
        for (name, data, kind) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_entry_type(*kind);
            if kind.is_symlink() {
                header.set_link_name("outside").unwrap();
            }
            header.set_cksum();
            archive.append_data(&mut header, name, *data).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
        format!(
            "{:x}  {}\n",
            Sha256::digest(fs::read(path).unwrap()),
            path.file_name().unwrap().to_str().unwrap()
        )
        .into_bytes()
    }

    #[tokio::test]
    async fn integrity_and_archive_failures_never_reach_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fixture.tar.gz");
        let original = b"installed binary";
        let installed = temp.path().join("installed");
        fs::write(&installed, original).unwrap();
        for members in [
            vec![("tucano-proxy", b"link".as_slice(), tar::EntryType::Symlink)],
            vec![
                ("tucano-proxy", b"one".as_slice(), tar::EntryType::Regular),
                ("tucano-proxy", b"two".as_slice(), tar::EntryType::Regular),
            ],
            vec![(
                "README.md",
                b"no executable".as_slice(),
                tar::EntryType::Regular,
            )],
        ] {
            let checksum = tar_fixture(&path, &members);
            let result = apply_candidate(
                &path,
                &checksum,
                "fixture.tar.gz",
                &Version::new(1, 0, 0),
                1,
                |binary| {
                    fs::copy(binary, &installed)?;
                    Ok(())
                },
            )
            .await;
            assert!(result.is_err());
            assert_eq!(fs::read(&installed).unwrap(), original);
        }
        let checksum = tar_fixture(
            &path,
            &[("tucano-proxy", b"binary", tar::EntryType::Regular)],
        );
        fs::write(&path, b"tampered").unwrap();
        assert!(apply_candidate(
            &path,
            &checksum,
            "fixture.tar.gz",
            &Version::new(1, 0, 0),
            1,
            |_| panic!("replacement after checksum failure")
        )
        .await
        .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn candidate_version_gates_disposable_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fixture.tar.gz");
        let installed = temp.path().join("installed");
        let session = temp.path().join("session-data");
        fs::write(&installed, b"original").unwrap();
        fs::write(&session, b"preserve").unwrap();
        let binary = b"#!/bin/sh\nprintf 'tucano-proxy 1.2.3\\n'\n";
        let checksum = tar_fixture(&path, &[("tucano-proxy", binary, tar::EntryType::Regular)]);
        assert!(apply_candidate(
            &path,
            &checksum,
            "fixture.tar.gz",
            &Version::new(1, 2, 4),
            2,
            |_| panic!("replacement after wrong version")
        )
        .await
        .is_err());
        assert_eq!(fs::read(&installed).unwrap(), b"original");
        apply_candidate(
            &path,
            &checksum,
            "fixture.tar.gz",
            &Version::new(1, 2, 3),
            2,
            |candidate| {
                let staged = temp.path().join("staged");
                fs::copy(candidate, &staged)?;
                fs::rename(staged, &installed)?;
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(fs::read(&installed).unwrap(), binary);
        assert_eq!(fs::read(&session).unwrap(), b"preserve");
    }

    #[test]
    fn desktop_assets_are_not_cli_candidates() {
        let release: Release = serde_json::from_value(json!({"tag_name":"v1.0.0", "draft":false, "prerelease":false,
            "assets":[{"name":"Tucano.Proxy_1.0.0_aarch64.dmg", "size":10, "browser_download_url":"https://github.com/plscabral/tucano-proxy/releases/download/v1.0.0/Tucano.Proxy_1.0.0_aarch64.dmg"}]})).unwrap();
        assert!(
            selected_asset(&release, &asset_name("aarch64-apple-darwin"))
                .unwrap()
                .is_none()
        );
        assert!(!version("1.0.0+new")
            .unwrap()
            .cmp_precedence(&version("1.0.0+old").unwrap())
            .is_gt());
        for path in [
            "../tucano-proxy",
            "/tucano-proxy",
            "a/../tucano-proxy",
            "C:\\tucano-proxy",
            "./tucano-proxy",
        ] {
            assert!(safe_member(path).is_err());
        }
    }
}
