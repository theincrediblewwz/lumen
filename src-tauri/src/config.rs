//! 应用级配置（与用户数据目录分离）
//!
//! 「白板存在哪」这个设置放在系统配置目录，
//! 这样即使数据目录被移动或删除，设置本身不会跟着丢。

use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppConfig {
    /// 用户指定的存储根目录；None 表示首次启动，尚未设置
    pub storage_root: Option<String>,
}

fn config_dir() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "无法定位系统配置目录".to_string())?;
    Ok(base.join("Lumen"))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

pub fn load() -> Result<AppConfig, String> {
    let p = config_path()?;
    if !p.exists() {
        return Ok(AppConfig::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| format!("读取配置失败: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("解析配置失败: {e}"))
}

pub fn save(cfg: &AppConfig) -> Result<(), String> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化配置失败: {e}"))?;
    storage::atomic_write(&config_path()?, &s)
}
