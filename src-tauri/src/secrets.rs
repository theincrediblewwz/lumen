//! API Key 安全存储（M5-7）。
//!
//! 密钥不写进应用自己的任何磁盘文件（config.json / localStorage 都不存明文），
//! 而是交给操作系统的原生凭据库保管：
//!   - macOS  → Keychain
//!   - Windows → 凭据管理器（Credential Manager）
//!   - Linux  → Secret Service（libsecret / GNOME Keyring 等）
//!
//! 前端只在内存里短暂持有明文用于发请求，落盘一律走这里。

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;
use zeroize::Zeroizing;

// Shared by every WebView in this native process. Never persist this cache,
// prefetch other accounts, or weaken the Keychain item's access controls.
// Holding this dedicated lock through the OS operation coalesces simultaneous
// reads and keeps write/delete ordering consistent with the cached value.
#[derive(Default)]
struct SessionSecrets {
    values: Mutex<HashMap<(String, String), Zeroizing<String>>>,
}

impl SessionSecrets {
    fn read(&self, service: &str, account: &str, load: impl FnOnce() -> Result<Option<String>, String>) -> Result<Option<String>, String> {
        let mut values = self.values.lock().map_err(|_| "凭据会话暂不可用".to_string())?;
        let id = (service.to_owned(), account.to_owned());
        if let Some(value) = values.get(&id) { return Ok(Some(value.to_string())); }
        let value = load()?;
        // Absence or denied/cancelled access must never become a cached empty key.
        if let Some(ref secret) = value { values.insert(id, Zeroizing::new(secret.clone())); }
        Ok(value)
    }

    fn write(&self, service: &str, account: &str, secret: &str, store: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let mut values = self.values.lock().map_err(|_| "凭据会话暂不可用".to_string())?;
        store()?;
        values.insert((service.to_owned(), account.to_owned()), Zeroizing::new(secret.to_owned()));
        Ok(())
    }

    fn delete(&self, service: &str, account: &str, remove: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let mut values = self.values.lock().map_err(|_| "凭据会话暂不可用".to_string())?;
        remove()?;
        values.remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }
}

static SESSION: Lazy<SessionSecrets> = Lazy::new(SessionSecrets::default);

#[cfg(not(feature = "isolated-preview"))]
const SERVICE: &str = "lumen.ai";
#[cfg(feature = "isolated-preview")]
const SERVICE: &str = "lumen.sync.preview";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("凭据库初始化失败: {e}"))
}

pub fn get_stored(account: &str, storage: Option<&str>) -> Result<Option<String>, String> {
    match storage {
        Some("local") => SESSION.read(&format!("local:{SERVICE}"), account, || crate::local_credentials::read(SERVICE, account)),
        None | Some("system") => get_secret(account),
        _ => Err("密钥保存方式无效".into()),
    }
}
pub fn set_stored(account: &str, secret: &str, storage: Option<&str>) -> Result<(), String> {
    if secret.is_empty() { return delete_stored(account, storage); }
    match storage {
        Some("local") => SESSION.write(&format!("local:{SERVICE}"), account, secret, || crate::local_credentials::write(SERVICE, account, Some(secret))),
        None | Some("system") => set_secret(account, secret),
        _ => Err("密钥保存方式无效".into()),
    }
}
pub fn delete_stored(account: &str, storage: Option<&str>) -> Result<(), String> {
    match storage {
        Some("local") => SESSION.delete(&format!("local:{SERVICE}"), account, || crate::local_credentials::write(SERVICE, account, None)),
        None | Some("system") => delete_secret(account),
        _ => Err("密钥保存方式无效".into()),
    }
}

/// 写入（或更新）某账户下的密钥。account 用于区分不同供应商配置，如 "openai"。
pub fn set_secret(account: &str, secret: &str) -> Result<(), String> {
    SESSION.write(SERVICE, account, secret, || {
        entry(account)?.set_password(secret).map_err(|_| "保存密钥失败，请检查系统凭据库授权".to_string())
    })
}

/// 读取密钥；不存在返回 None（不视为错误）。
pub fn get_secret(account: &str) -> Result<Option<String>, String> {
    SESSION.read(SERVICE, account, || match entry(account)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("尚未获准读取已保存密钥；原连接和密钥未更改，请再次操作以重试授权".to_string()),
    })
}

/// 删除密钥；不存在也算成功（幂等）。
pub fn delete_secret(account: &str) -> Result<(), String> {
    SESSION.delete(SERVICE, account, || match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("删除密钥失败，请检查系统凭据库授权".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, atomic::{AtomicUsize, Ordering}};

    #[test]
    fn concurrent_windows_read_once_per_complete_credential_identity() {
        let cache = Arc::new(SessionSecrets::default());
        let reads = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8).map(|_| {
            let (cache, reads, start) = (cache.clone(), reads.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                cache.read("lumen.ai", "profile.version-A", || {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Ok(Some("synthetic-A".into()))
                }).unwrap()
            })
        }).collect();
        for worker in workers { assert_eq!(worker.join().unwrap().as_deref(), Some("synthetic-A")); }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(cache.read("lumen.ai", "profile.version-A", || panic!("reopened WebView must reuse authorization")).unwrap().as_deref(), Some("synthetic-A"));
        for (service, account) in [("lumen.ai", "profile.version-B"), ("lumen.sync.preview", "profile.version-A"), ("lumen.ai", "apikey.openai")] {
            assert_eq!(cache.read(service, account, || Ok(Some(account.into()))).unwrap().as_deref(), Some(account));
        }
        assert_eq!(SessionSecrets::default().read("lumen.ai", "profile.version-A", || Ok(Some("new-session".into()))).unwrap().as_deref(), Some("new-session"));
    }

    #[test]
    fn denied_or_missing_credentials_can_be_retried_without_losing_original_data() {
        let cache = SessionSecrets::default();
        assert!(cache.read("service", "account", || Err("denied".into())).is_err());
        assert_eq!(cache.read("service", "account", || Ok(None)).unwrap(), None);
        assert_eq!(cache.read("service", "account", || Ok(Some("original".into()))).unwrap().as_deref(), Some("original"));
        assert!(cache.write("service", "account", "replacement", || Err("denied".into())).is_err());
        assert!(cache.delete("service", "account", || Err("denied".into())).is_err());
        assert_eq!(cache.read("service", "account", || panic!("failed mutation must preserve cached original")).unwrap().as_deref(), Some("original"));
        cache.write("service", "account", "replacement", || Ok(())).unwrap();
        assert_eq!(cache.read("service", "account", || panic!("saved key should already be in session")).unwrap().as_deref(), Some("replacement"));
        cache.write("service", "other", "separate", || Ok(())).unwrap();
        cache.delete("service", "account", || Ok(())).unwrap();
        assert_eq!(cache.read("service", "account", || Ok(None)).unwrap(), None);
        assert_eq!(cache.read("service", "other", || panic!("unrelated account must remain cached")).unwrap().as_deref(), Some("separate"));
    }
}
