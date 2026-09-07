//! API Key 安全存储（M5-7）。
//!
//! 密钥不写进应用自己的任何磁盘文件（config.json / localStorage 都不存明文），
//! 而是交给操作系统的原生凭据库保管：
//!   - macOS  → Keychain
//!   - Windows → 凭据管理器（Credential Manager）
//!   - Linux  → Secret Service（libsecret / GNOME Keyring 等）
//!
//! 前端只在内存里短暂持有明文用于发请求，落盘一律走这里。

const SERVICE: &str = "lumen.ai";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("凭据库初始化失败: {e}"))
}

/// 写入（或更新）某账户下的密钥。account 用于区分不同供应商配置，如 "openai"。
pub fn set_secret(account: &str, secret: &str) -> Result<(), String> {
    let e = entry(account)?;
    e.set_password(secret)
        .map_err(|err| format!("保存密钥失败: {err}"))
}

/// 读取密钥；不存在返回 None（不视为错误）。
pub fn get_secret(account: &str) -> Result<Option<String>, String> {
    let e = entry(account)?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("读取密钥失败: {err}")),
    }
}

/// 删除密钥；不存在也算成功（幂等）。
pub fn delete_secret(account: &str) -> Result<(), String> {
    let e = entry(account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("删除密钥失败: {err}")),
    }
}
