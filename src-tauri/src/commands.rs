//! Tauri 命令层：前端唯一入口，所有路径参数在此校验（DESIGN §5.7）

use crate::config::{self, AppConfig};
use crate::secrets;
use crate::storage;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME").to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

/// 取当前存储根目录；未设置或不存存在则报错，由前端引导用户重新选择
fn root() -> Result<PathBuf, String> {
    let cfg = config::load()?;
    let root = cfg.storage_root.ok_or_else(|| "尚未设置存储目录".to_string())?;
    let root = PathBuf::from(root);
    if !root.exists() {
        return Err(format!("存储目录不存在：{}", root.display()));
    }
    Ok(root)
}

// ───────────────── 配置与存储根目录（M1-4） ─────────────────

#[tauri::command]
pub fn config_get() -> Result<AppConfig, String> {
    config::load()
}

#[tauri::command]
pub fn config_set_storage_root(root: String) -> Result<AppConfig, String> {
    // 顺便把目录结构与 index.json 建好，后续操作无需再判断
    storage::ensure_storage(std::path::Path::new(&root))?;
    let cfg = AppConfig { storage_root: Some(root) };
    config::save(&cfg)?;
    Ok(cfg)
}

// ───────────────── 项目（M1-5） ─────────────────

#[tauri::command]
pub fn projects_list() -> Result<Vec<storage::ProjectMeta>, String> {
    let index = storage::read_index(&root()?)?;
    Ok(index.projects)
}

#[tauri::command]
pub fn project_create(name: String) -> Result<storage::ProjectMeta, String> {
    storage::create_project(&root()?, &name)
}

#[tauri::command]
pub fn project_delete(id: String) -> Result<(), String> {
    storage::delete_project(&root()?, &id)
}

#[tauri::command]
pub fn project_rename(id: String, name: String) -> Result<storage::ProjectMeta, String> {
    storage::rename_project(&root()?, &id, &name)
}

// ───────────────── 白板（M1-5） ─────────────────

#[tauri::command]
pub fn boards_list(project_id: String) -> Result<Vec<storage::BoardMeta>, String> {
    Ok(storage::read_project(&root()?, &project_id)?.boards)
}

#[tauri::command]
pub fn board_create(project_id: String, name: String) -> Result<storage::BoardMeta, String> {
    storage::create_board(&root()?, &project_id, &name)
}

#[tauri::command]
pub fn board_load(project_id: String, board_id: String) -> Result<storage::BoardFile, String> {
    storage::load_board(&root()?, &project_id, &board_id)
}

#[tauri::command]
pub fn board_save(board: storage::BoardFile) -> Result<(), String> {
    storage::save_board(&root()?, &board)
}

#[tauri::command]
pub fn board_delete(project_id: String, board_id: String) -> Result<(), String> {
    storage::delete_board(&root()?, &project_id, &board_id)
}

#[tauri::command]
pub fn board_rename(
    project_id: String,
    board_id: String,
    name: String,
) -> Result<storage::BoardMeta, String> {
    storage::rename_board(&root()?, &project_id, &board_id, &name)
}


// ───────────────── 文档（M4） ─────────────────

#[tauri::command]
pub fn docs_list(project_id: String, board_id: String) -> Result<Vec<storage::DocRef>, String> {
    storage::list_docs(&root()?, &project_id, &board_id)
}

#[tauri::command]
pub fn doc_import(
    project_id: String,
    board_id: String,
    src_path: String,
) -> Result<storage::DocRef, String> {
    storage::import_doc(&root()?, &project_id, &board_id, &src_path)
}

#[tauri::command]
pub fn doc_write(
    project_id: String,
    board_id: String,
    title: String,
    content: String,
) -> Result<storage::DocRef, String> {
    storage::write_doc(&root()?, &project_id, &board_id, &title, &content)
}

#[tauri::command]
pub fn doc_read(project_id: String, board_id: String, path: String) -> Result<String, String> {
    storage::read_doc(&root()?, &project_id, &board_id, &path)
}

#[tauri::command]
pub fn doc_delete(project_id: String, board_id: String, path: String) -> Result<(), String> {
    storage::delete_doc(&root()?, &project_id, &board_id, &path)
}

// ───────────────── AI 对话历史持久化（M5） ─────────────────

#[tauri::command]
pub fn chats_read(project_id: String, board_id: String) -> Result<String, String> {
    storage::read_chats(&root()?, &project_id, &board_id)
}

#[tauri::command]
pub fn chats_write(project_id: String, board_id: String, content: String) -> Result<(), String> {
    storage::write_chats(&root()?, &project_id, &board_id, &content)
}

// ───────────────── API Key 安全存储（M5-7，OS 凭据库加密） ─────────────────

#[tauri::command]
pub fn secret_set(account: String, secret: String) -> Result<(), String> {
    if secret.is_empty() {
        // 空视为清除，避免在凭据库留空条目
        return secrets::delete_secret(&account);
    }
    secrets::set_secret(&account, &secret)
}

#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    secrets::get_secret(&account)
}

#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    secrets::delete_secret(&account)
}

/// 只查询是否存在密钥，不回传明文（供 UI 显示「已保存」状态）。
#[tauri::command]
pub fn secret_has(account: String) -> Result<bool, String> {
    Ok(secrets::get_secret(&account)?.is_some())
}


// ───────────────── 用系统默认程序打开文档（O-4，M5/M6） ─────────────────

/// 用操作系统默认程序打开白板 docs/ 下的某个文件（如 PDF）。
/// 路径先经 storage 校验，避免任意路径穿越；不依赖额外插件，用系统命令拉起。
#[tauri::command]
pub fn open_doc_external(
    project_id: String,
    board_id: String,
    path: String,
) -> Result<(), String> {
    let p = storage::resolve_doc_path(&root()?, &project_id, &board_id, &path)?;
    open_path_os(&p)
}

#[cfg(target_os = "windows")]
fn open_path_os(p: &std::path::Path) -> Result<(), String> {
    // 用 explorer 打开，避免 cmd start 的引号/转义问题
    std::process::Command::new("explorer")
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开失败: {e}"))
}

#[cfg(target_os = "macos")]
fn open_path_os(p: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开失败: {e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_path_os(p: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开失败: {e}"))
}
