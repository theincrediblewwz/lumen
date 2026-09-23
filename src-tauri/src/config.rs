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
    #[cfg(feature = "isolated-preview")]
    { return std::env::current_exe().map_err(|e| e.to_string())?.parent().map(|p|p.join(".preview").join("config")).ok_or_else(||"预览程序目录无效".to_string()); }
    #[cfg(not(feature = "isolated-preview"))]
    {
    let base = dirs::config_dir().ok_or_else(|| "无法定位系统配置目录".to_string())?;
    Ok(base.join("Lumen"))
    }
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

#[cfg(feature = "isolated-preview")]
fn resolve_preview_root(mut cfg: AppConfig, executable_directory: &std::path::Path) -> AppConfig {
    if let Some(root) = cfg.storage_root.as_ref().filter(|root| PathBuf::from(root).is_relative()) {
        cfg.storage_root = Some(executable_directory.join(root).to_string_lossy().into_owned());
    }
    cfg
}

pub fn load() -> Result<AppConfig, String> {
    let p = config_path()?;
    if !p.exists() {
        return Ok(AppConfig::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| format!("读取配置失败: {e}"))?;
    let cfg: AppConfig = serde_json::from_str(&s).map_err(|e| format!("解析配置失败: {e}"))?;
    #[cfg(feature = "isolated-preview")]
    {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let directory = executable.parent().ok_or_else(|| "预览程序目录无效".to_string())?;
        return Ok(resolve_preview_root(cfg, directory));
    }
    #[cfg(not(feature = "isolated-preview"))]
    Ok(cfg)
}

pub fn save(cfg: &AppConfig) -> Result<(), String> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化配置失败: {e}"))?;
    storage::atomic_write(&config_path()?, &s)
}

#[cfg(all(test, feature = "isolated-preview"))]
mod tests {
    use super::*;

    #[test]
    fn preview_relative_library_moves_with_executable_but_absolute_selection_stays() {
        let first = std::env::temp_dir().join("lumen-preview-original");
        let moved = std::env::temp_dir().join("lumen-preview-moved");
        let relative = AppConfig { storage_root: Some(".preview/library".into()) };
        assert_eq!(resolve_preview_root(relative.clone(), &first).storage_root,
            Some(first.join(".preview/library").to_string_lossy().into_owned()));
        assert_eq!(resolve_preview_root(relative, &moved).storage_root,
            Some(moved.join(".preview/library").to_string_lossy().into_owned()));
        let selected = AppConfig { storage_root: Some(first.join("chosen-library").to_string_lossy().into_owned()) };
        assert_eq!(resolve_preview_root(selected.clone(), &moved).storage_root, selected.storage_root);
        assert_eq!(resolve_preview_root(AppConfig::default(), &moved).storage_root, None);
    }
}
