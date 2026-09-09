use anyhow::{bail, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub api_version: u32,
    pub session: String,
    pub pid: u32,
    pub endpoint: String,
    pub token: String,
    pub read_token: String,
    pub proxy_port: u16,
    pub started_at: u64,
    pub instance_id: String,
}

pub fn session_path(root: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("session names must contain 1–64 ASCII letters, digits, underscores or hyphens");
    }
    let upper = name.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && matches!(upper.as_bytes()[3], b'1'..=b'9'))
    {
        bail!("session name is reserved by the operating system");
    }
    Ok(root.join("sessions").join(name))
}

pub(crate) fn private_dir(path: &Path) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!(
                "data directory must be a real directory: {}",
                path.display()
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } {
                bail!("data directory is owned by another user");
            }
        }
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    owner_only_acl(path, true)?;
    Ok(())
}

pub fn create_session(root: &Path, name: &str) -> Result<PathBuf> {
    let path = session_path(root, name)?;
    private_dir(root)?;
    private_dir(&root.join("sessions"))?;
    private_dir(&path)?;
    Ok(path)
}

pub fn list_sessions(root: &Path) -> Result<Vec<String>> {
    let directory = root.join("sessions");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if session_path(root, name).is_ok() {
                result.push(name.to_owned());
            }
        }
    }
    result.sort();
    Ok(result)
}

pub fn delete_session(root: &Path, name: &str) -> Result<()> {
    let path = session_path(root, name)?;
    if !path.exists() {
        bail!("session does not exist: {name}");
    }
    private_dir(&path)?;
    let lock = SessionLock::acquire(root, name)?;
    // The lock lives outside the removed directory: concurrent starts cannot
    // open a fresh inode while this deletion still holds the old lock.
    fs::remove_dir_all(&path)?;
    drop(lock);
    Ok(())
}

pub(crate) struct SessionLock {
    _file: File,
}
impl SessionLock {
    pub(crate) fn acquire(root: &Path, name: &str) -> Result<Self> {
        session_path(root, name)?;
        private_dir(root)?;
        let locks = root.join("locks");
        private_dir(&locks)?;
        Self::at(&locks.join(format!("{name}.lock")))
            .with_context(|| format!("session '{name}' is already running or locked"))
    }
    pub(crate) fn at(path: &Path) -> Result<Self> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            bail!("lock cannot be a symlink");
        }
        let file = options.open(path)?;
        file.try_lock_exclusive()?;
        Ok(Self { _file: file })
    }
}

pub(crate) fn write_descriptor(path: &Path, descriptor: &RuntimeDescriptor) -> Result<()> {
    let parent = path.parent().context("runtime descriptor has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    owner_only_acl(temporary.path(), false)?;
    serde_json::to_writer(&mut temporary, descriptor)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(windows)]
fn owner_only_acl(path: &Path, directory: bool) -> Result<()> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    #[link(name = "advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn GetSecurityDescriptorDacl(
            descriptor: *const c_void,
            present: *mut i32,
            dacl: *mut *mut c_void,
            defaulted: *mut i32,
        ) -> i32;
        fn SetNamedSecurityInfoW(
            name: *mut u16,
            object_type: u32,
            information: u32,
            owner: *const c_void,
            group: *const c_void,
            dacl: *const c_void,
            sacl: *const c_void,
        ) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    // Protected DACL, full control for OWNER RIGHTS only. Directory entries
    // inherit the restriction, including SQLite, CA keys and temporary files.
    let sddl = if directory {
        "D:P(A;OICI;FA;;;OW)"
    } else {
        "D:P(A;;FA;;;OW)"
    };
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut descriptor = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = ptr::null_mut();
        if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) == 0
            || present == 0
        {
            let error = std::io::Error::last_os_error();
            LocalFree(descriptor);
            return Err(error.into());
        }
        let status = SetNamedSecurityInfoW(
            name.as_mut_ptr(),
            1,
            0x80000004,
            ptr::null(),
            ptr::null(),
            dacl,
            ptr::null(),
        );
        LocalFree(descriptor);
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status as i32).into());
        }
    }
    Ok(())
}

pub(crate) struct RuntimeGuard {
    pub path: PathBuf,
    pub instance: String,
}
impl Drop for RuntimeGuard {
    fn drop(&mut self) {
        let ours = fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RuntimeDescriptor>(&bytes).ok())
            .is_some_and(|runtime| runtime.instance_id == self.instance);
        if ours {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_and_lock_aware_deletion() {
        let root = tempfile::tempdir().unwrap();
        for name in ["", "..", "a/b", "a\\b", "a.b", "á"] {
            assert!(session_path(root.path(), name).is_err());
        }
        let path = create_session(root.path(), "work").unwrap();
        let lock = SessionLock::acquire(root.path(), "work").unwrap();
        assert!(delete_session(root.path(), "work").is_err());
        assert!(path.exists());
        drop(lock);
        delete_session(root.path(), "work").unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn guard_does_not_remove_replacement_runtime() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.json");
        let descriptor = RuntimeDescriptor {
            api_version: 1,
            session: "work".into(),
            pid: 1,
            endpoint: "http://127.0.0.1:7777".into(),
            token: "admin".into(),
            read_token: "read".into(),
            proxy_port: 8888,
            started_at: 1,
            instance_id: "new".into(),
        };
        write_descriptor(&path, &descriptor).unwrap();
        drop(RuntimeGuard {
            path: path.clone(),
            instance: "old".into(),
        });
        assert!(path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(RuntimeGuard {
            path: path.clone(),
            instance: "new".into(),
        });
        assert!(!path.exists());
    }
}
