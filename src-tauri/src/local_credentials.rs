//! User-approved prompt-free alternative. The encryption key lives on the same
//! device: this is NOT protection against software running as the same OS user.
//! Never use the board root, synchronize/export these files, or fall back to OS
//! Keychain on errors. Existing Keychain entries are not migrated automatically.
use ring::{aead, rand::{SecureRandom, SystemRandom}};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::Mutex};
use once_cell::sync::Lazy;
use zeroize::Zeroizing;

static LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
const ERROR: &str = "本机凭据文件不可用，原文件已保留；请检查文件权限或重新填写密钥";
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Vault { version: u8, entries: BTreeMap<String, String> }
struct LocalVault { directory: PathBuf }

fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N]; SystemRandom::new().fill(&mut bytes).map_err(|_| ERROR)?; Ok(bytes)
}
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b|format!("{b:02x}")).collect() }
fn unhex(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 || !text.is_ascii() { return Err(ERROR.into()); }
    (0..text.len()).step_by(2).map(|i|u8::from_str_radix(&text[i..i+2],16).map_err(|_|ERROR.to_string())).collect()
}
fn private_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_|ERROR)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() { return Err(ERROR.into()); }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 { return Err(ERROR.into()); }
    }
    Ok(())
}
fn create_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(path).map_err(|_|ERROR)?;
    file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|_|ERROR.to_string())?;
    sync_directory(path.parent().ok_or(ERROR)?)
}
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)] { fs::File::open(path).and_then(|file|file.sync_all()).map_err(|_|ERROR)?; }
    #[cfg(not(unix))] let _ = path;
    Ok(())
}
impl LocalVault {
    fn prepare(&self) -> Result<(), String> {
        if !self.directory.exists() {
            fs::create_dir_all(self.directory.parent().ok_or(ERROR)?).map_err(|_|ERROR)?;
            #[allow(unused_mut)] let mut builder = fs::DirBuilder::new();
            #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
            builder.create(&self.directory).map_err(|_|ERROR)?;
            sync_directory(self.directory.parent().ok_or(ERROR)?)?;
        }
        let metadata = fs::symlink_metadata(&self.directory).map_err(|_|ERROR)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(ERROR.into()); }
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 { return Err(ERROR.into()); }
        }
        Ok(())
    }
    fn load(&self) -> Result<Vault, String> {
        let path = self.directory.join("vault.json");
        if !path.exists() { return Ok(Vault { version: 1, entries: BTreeMap::new() }); }
        private_file(&path)?;
        if fs::metadata(&path).map_err(|_|ERROR)?.len() > 2_000_000 { return Err(ERROR.into()); }
        let vault: Vault = serde_json::from_slice(&fs::read(path).map_err(|_|ERROR)?).map_err(|_|ERROR)?;
        if vault.version != 1 || vault.entries.len() > 2048 { return Err(ERROR.into()); }
        Ok(vault)
    }
    fn key(&self, create: bool) -> Result<aead::LessSafeKey, String> {
        let path = self.directory.join("device.key");
        if !path.exists() {
            // Never replace a lost encryption key or orphan existing ciphertext.
            if !create || self.directory.join("vault.json").exists() { return Err(ERROR.into()); }
            let key = Zeroizing::new(random::<32>()?);
            create_private(&path, key.as_ref())?;
        }
        private_file(&path)?;
        if fs::metadata(&path).map_err(|_|ERROR)?.len() != 32 { return Err(ERROR.into()); }
        let key = Zeroizing::new(fs::read(path).map_err(|_|ERROR)?);
        let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_|ERROR)?;
        Ok(aead::LessSafeKey::new(unbound))
    }
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        if !self.directory.exists() { return Ok(None); }
        self.prepare()?;
        let vault = self.load()?;
        let Some(encoded) = vault.entries.get(account) else { return Ok(None); };
        let mut data = Zeroizing::new(unhex(encoded)?);
        if data.len() < 12 + aead::AES_256_GCM.tag_len() || data.len() > 32768 { return Err(ERROR.into()); }
        let nonce = aead::Nonce::try_assume_unique_for_key(&data[..12]).map_err(|_|ERROR)?;
        let aad = format!("{service}\0{account}");
        let plaintext = self.key(false)?.open_in_place(nonce, aead::Aad::from(aad.as_bytes()), &mut data[12..]).map_err(|_|ERROR)?;
        String::from_utf8(plaintext.to_vec()).map(Some).map_err(|_|ERROR.into())
    }
    fn mutate(&self, service: &str, account: &str, secret: Option<&str>) -> Result<(), String> {
        if account.is_empty() || account.len() > 256 || secret.is_some_and(|s|s.len() > 16000) { return Err(ERROR.into()); }
        self.prepare()?;
        let mut vault = self.load()?;
        if secret.is_none() && !vault.entries.contains_key(account) { return Ok(()); }
        if let Some(secret) = secret {
            let key = self.key(true)?;
            let nonce = random::<12>()?;
            let mut data = Zeroizing::new(secret.as_bytes().to_vec());
            let aad = format!("{service}\0{account}");
            key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad.as_bytes()), &mut *data).map_err(|_|ERROR)?;
            let mut ciphertext = nonce.to_vec(); ciphertext.extend_from_slice(&data);
            vault.entries.insert(account.into(), hex(&ciphertext));
        } else { vault.entries.remove(account); }
        if vault.entries.len() > 2048 { return Err(ERROR.into()); }
        let bytes = serde_json::to_vec(&vault).map_err(|_|ERROR)?;
        if bytes.len() > 2_000_000 { return Err(ERROR.into()); }
        let temporary = self.directory.join(format!(".{}.tmp", hex(&random::<16>()?)));
        create_private(&temporary, &bytes)?;
        let destination = self.directory.join("vault.json");
        if destination.exists() { private_file(&destination)?; }
        if fs::rename(&temporary, &destination).is_err() { let _ = fs::remove_file(&temporary); return Err(ERROR.into()); }
        sync_directory(&self.directory)?;
        Ok(())
    }
    fn lock(&self) -> Result<fs::File, String> {
        self.prepare()?;
        let path = self.directory.join("vault.lock");
        if path.exists() { private_file(&path)?; }
        let mut options = OpenOptions::new(); options.create(true).read(true).write(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let file = options.open(path).map_err(|_|ERROR)?;
        file.try_lock().map_err(|_|"本机凭据正由另一个应用窗口保存，请稍后重试")?;
        Ok(file)
    }
}
pub fn read(service: &str, account: &str) -> Result<Option<String>, String> {
    let _guard = LOCK.lock().map_err(|_|ERROR)?;
    let vault = LocalVault { directory: crate::config::config_dir()?.join("credentials-local") };
    if !vault.directory.exists() { return Ok(None); }
    let _file_lock = vault.lock()?;
    vault.read(service, account)
}
pub fn write(service: &str, account: &str, secret: Option<&str>) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_|ERROR)?;
    let vault = LocalVault { directory: crate::config::config_dir()?.join("credentials-local") };
    if secret.is_none() && !vault.directory.exists() { return Ok(()); }
    let _file_lock = vault.lock()?;
    vault.mutate(service, account, secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> LocalVault { LocalVault { directory: std::env::temp_dir().join(format!("lumen-vault-test-{}", hex(&random::<16>().unwrap()))) } }
    #[test]
    fn local_roundtrip_restart_isolation_and_ciphertext_integrity() {
        let vault = fixture();
        vault.mutate("test", "account-A", Some("synthetic-A")).unwrap();
        vault.mutate("test", "account-B", Some("synthetic-B")).unwrap();
        assert_eq!(vault.read("test", "account-A").unwrap().as_deref(), Some("synthetic-A"));
        let bytes = fs::read(vault.directory.join("vault.json")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("synthetic-"));
        assert_eq!(LocalVault { directory: vault.directory.clone() }.read("test", "account-B").unwrap().as_deref(), Some("synthetic-B"));
        assert!(vault.read("other-service", "account-A").is_err());
        let mut bad = vault.load().unwrap();
        bad.entries.insert("account-A".into(), bad.entries["account-B"].clone());
        fs::write(vault.directory.join("vault.json"), serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(vault.read("test", "account-A").is_err());
        fs::write(vault.directory.join("vault.json"), &bytes).unwrap();
        vault.mutate("test", "account-A", None).unwrap();
        assert_eq!(vault.read("test", "account-A").unwrap(), None);
        assert_eq!(vault.read("test", "account-B").unwrap().as_deref(), Some("synthetic-B"));
        fs::remove_file(vault.directory.join("device.key")).unwrap();
        let before = fs::read(vault.directory.join("vault.json")).unwrap();
        assert!(vault.mutate("test", "account-B", Some("replacement")).is_err());
        assert_eq!(fs::read(vault.directory.join("vault.json")).unwrap(), before);
        fs::remove_dir_all(&vault.directory).unwrap();
    }
    #[test]
    fn corrupt_vault_is_preserved_and_private_modes_are_enforced() {
        let vault = fixture(); vault.mutate("test", "account", Some("original")).unwrap();
        fs::write(vault.directory.join("vault.json"), b"damaged fixture").unwrap();
        assert!(vault.mutate("test", "account", Some("replacement")).is_err());
        assert_eq!(fs::read(vault.directory.join("vault.json")).unwrap(), b"damaged fixture");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&vault.directory).unwrap().permissions().mode() & 0o777, 0o700);
            for name in ["device.key", "vault.json"] { assert_eq!(fs::metadata(vault.directory.join(name)).unwrap().permissions().mode() & 0o777, 0o600); }
            fs::set_permissions(vault.directory.join("device.key"), fs::Permissions::from_mode(0o644)).unwrap();
            assert!(vault.key(false).is_err());
        }
        fs::remove_dir_all(&vault.directory).unwrap();
    }
    #[test]
    fn independent_instances_are_locked_and_empty_delete_does_not_poison_new_vault() {
        let vault = fixture();
        vault.mutate("test", "missing", None).unwrap();
        vault.mutate("test", "new", Some("first-key")).unwrap();
        let lock = vault.lock().unwrap();
        assert!(LocalVault { directory: vault.directory.clone() }.lock().is_err());
        drop(lock);
        assert!(vault.lock().is_ok());
        fs::remove_dir_all(&vault.directory).unwrap();
    }
}
