//! 存储层：文件即数据（DESIGN.md §6）
//!
//! 目录布局：
//! ```text
//! <root>/index.json
//! <root>/<project_id>/project.json
//! <root>/<project_id>/<board_id>/board.json
//! <root>/<project_id>/<board_id>/docs/*.md
//! ```
//! 白板与它的 Markdown 同处一个文件夹，可整体复制 / 迁移 / 用 Git 管理。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FORMAT_VERSION: u32 = 1;

// ─────────────────────────── 数据模型 ───────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct IndexFile {
    pub version: u32,
    #[serde(default)]
    pub projects: Vec<ProjectMeta>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ProjectFile {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub boards: Vec<BoardMeta>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BoardMeta {
    pub id: String,
    pub name: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, zoom: 1.0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DocRef {
    pub path: String, // 相对白板文件夹，保证整个根目录可移动
    pub title: String,
    #[serde(default)]
    pub bytes: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BoardNode {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    pub x: f64,
    pub y: f64,
    #[serde(default = "default_node_w")]
    pub w: f64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub docs: Vec<DocRef>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_node_w() -> f64 {
    240.0
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BoardEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub directed: bool,
    #[serde(default)]
    pub label: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BoardFile {
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub viewport: Viewport,
    #[serde(default)]
    pub nodes: Vec<BoardNode>,
    #[serde(default)]
    pub edges: Vec<BoardEdge>,
}

// ─────────────────────────── 基础工具 ───────────────────────────

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn new_id(prefix: &str) -> String {
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}_{:x}{:x}", prefix, ns, n)
}

/// 白板/项目 id 会参与拼路径，必须挡住 `..`、路径分隔符等穿越写法。
pub fn safe_id(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("非法的 id：{id}"));
    }
    Ok(id)
}

/// 原子写：先写临时文件并 fsync，再改名替换。
/// 断电/崩溃时不会留下半截 JSON（DESIGN §6.5）。
pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }

    let tmp = path.with_file_name(format!(
        "{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("file")
    ));

    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("创建临时文件失败: {e}"))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("写入失败: {e}"))?;
        f.sync_all().map_err(|e| format!("刷盘失败: {e}"))?;
    }

    // Windows 的 rename 不允许覆盖已存在文件，先删除再改名。
    // 严格意义上这一步不是原子的，但窗口极小且已是平台上的通用做法。
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("删除旧文件失败: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("原子替换失败: {e}"))?;
    Ok(())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let s = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;
    atomic_write(path, &s)
}

// ─────────────────────────── 路径 ───────────────────────────

pub fn index_path(root: &Path) -> PathBuf {
    root.join("index.json")
}
pub fn project_dir(root: &Path, project_id: &str) -> PathBuf {
    root.join(project_id)
}
pub fn project_file(root: &Path, project_id: &str) -> PathBuf {
    project_dir(root, project_id).join("project.json")
}
pub fn board_dir(root: &Path, project_id: &str, board_id: &str) -> PathBuf {
    project_dir(root, project_id).join(board_id)
}
pub fn board_file(root: &Path, project_id: &str, board_id: &str) -> PathBuf {
    board_dir(root, project_id, board_id).join("board.json")
}

// ─────────────────────────── 仓储操作 ───────────────────────────

pub fn ensure_storage(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("创建存储根目录失败: {e}"))?;
    let idx = index_path(root);
    if !idx.exists() {
        write_json(&idx, &IndexFile { version: FORMAT_VERSION, projects: vec![] })?;
    }
    Ok(())
}

pub fn read_index(root: &Path) -> Result<IndexFile, String> {
    let p = index_path(root);
    if !p.exists() {
        return Ok(IndexFile::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| format!("读取 index.json 失败: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("解析 index.json 失败: {e}"))
}

pub fn create_project(root: &Path, name: &str) -> Result<ProjectMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("项目名不能为空".into());
    }
    ensure_storage(root)?;

    let id = new_id("p");
    let now = now_iso();
    let meta = ProjectMeta { id: id.clone(), name: name.to_string(), created_at: now.clone() };

    let mut index = read_index(root)?;
    index.version = FORMAT_VERSION;
    index.projects.push(meta.clone());
    write_json(&index_path(root), &index)?;

    let pf = ProjectFile {
        version: FORMAT_VERSION,
        id,
        name: name.to_string(),
        created_at: now.clone(),
        updated_at: now,
        boards: vec![],
    };
    write_json(&project_file(root, &pf.id), &pf)?;
    Ok(meta)
}

pub fn read_project(root: &Path, project_id: &str) -> Result<ProjectFile, String> {
    let p = project_file(root, safe_id(project_id)?);
    let s = fs::read_to_string(&p).map_err(|e| format!("读取 project.json 失败: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("解析 project.json 失败: {e}"))
}

pub fn delete_project(root: &Path, project_id: &str) -> Result<(), String> {
    let pid = safe_id(project_id)?;
    let mut index = read_index(root)?;
    index.projects.retain(|p| p.id != pid);
    write_json(&index_path(root), &index)?;

    let dir = project_dir(root, pid);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除项目目录失败: {e}"))?;
    }
    Ok(())
}

pub fn create_board(root: &Path, project_id: &str, name: &str) -> Result<BoardMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("白板名不能为空".into());
    }
    let pid = safe_id(project_id)?;
    let mut project = read_project(root, pid)?;

    let id = new_id("b");
    let now = now_iso();
    let meta = BoardMeta { id: id.clone(), name: name.to_string(), updated_at: now.clone() };

    project.boards.push(meta.clone());
    project.updated_at = now.clone();
    write_json(&project_file(root, pid), &project)?;

    let board = BoardFile {
        version: FORMAT_VERSION,
        id: id.clone(),
        name: name.to_string(),
        project_id: pid.to_string(),
        created_at: now.clone(),
        updated_at: now,
        viewport: Viewport::default(),
        nodes: vec![],
        edges: vec![],
    };
    write_json(&board_file(root, pid, &id), &board)?;
    // 白板自带的文档目录
    fs::create_dir_all(board_dir(root, pid, &id).join("docs"))
        .map_err(|e| format!("创建 docs 目录失败: {e}"))?;
    Ok(meta)
}

pub fn load_board(root: &Path, project_id: &str, board_id: &str) -> Result<BoardFile, String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    let p = board_file(root, pid, bid);
    let s = fs::read_to_string(&p).map_err(|e| format!("读取 board.json 失败: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("解析 board.json 失败: {e}"))
}

pub fn save_board(root: &Path, board: &BoardFile) -> Result<(), String> {
    let pid = safe_id(&board.project_id)?;
    let bid = safe_id(&board.id)?;
    let mut board = board.clone();
    board.version = FORMAT_VERSION;
    board.updated_at = now_iso();
    write_json(&board_file(root, pid, bid), &board)
}

pub fn delete_board(root: &Path, project_id: &str, board_id: &str) -> Result<(), String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    let mut project = read_project(root, pid)?;
    project.boards.retain(|b| b.id != bid);
    project.updated_at = now_iso();
    write_json(&project_file(root, pid), &project)?;

    let dir = board_dir(root, pid, bid);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除白板目录失败: {e}"))?;
    }
    Ok(())
}


pub fn rename_project(root: &Path, project_id: &str, name: &str) -> Result<ProjectMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("项目名不能为空".into());
    }
    let pid = safe_id(project_id)?;

    // index.json 里的元信息
    let mut index = read_index(root)?;
    let meta = index
        .projects
        .iter_mut()
        .find(|p| p.id == pid)
        .ok_or_else(|| format!("项目不存在：{pid}"))?;
    meta.name = name.to_string();
    let updated = meta.clone();
    write_json(&index_path(root), &index)?;

    // project.json 里的名字
    let mut project = read_project(root, pid)?;
    project.name = name.to_string();
    project.updated_at = now_iso();
    write_json(&project_file(root, pid), &project)?;

    Ok(updated)
}

pub fn rename_board(
    root: &Path,
    project_id: &str,
    board_id: &str,
    name: &str,
) -> Result<BoardMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("白板名不能为空".into());
    }
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;

    // project.json 的 boards[] 摘要
    let now = now_iso();
    let mut project = read_project(root, pid)?;
    let meta = project
        .boards
        .iter_mut()
        .find(|b| b.id == bid)
        .ok_or_else(|| format!("白板不存在：{bid}"))?;
    meta.name = name.to_string();
    meta.updated_at = now.clone();
    let updated = meta.clone();
    project.updated_at = now.clone();
    write_json(&project_file(root, pid), &project)?;

    // board.json 本体
    let mut board = load_board(root, pid, bid)?;
    board.name = name.to_string();
    board.updated_at = now;
    write_json(&board_file(root, pid, bid), &board)?;

    Ok(updated)
}

// ─────────────────────────── 文档（M4） ───────────────────────────

pub fn docs_dir(root: &Path, project_id: &str, board_id: &str) -> PathBuf {
    board_dir(root, project_id, board_id).join("docs")
}

/// 校验文档相对路径：只允许 docs/ 下的单层 .md 文件名，挡住穿越。
fn safe_doc_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err("非法的文档名".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("文档名不能包含路径分隔符".into());
    }
    Ok(name.to_string())
}

/// 探测字节序列的编码并解码为 UTF-8 字符串（M4-7）。
/// 顺序：BOM(UTF-8/UTF-16) → 严格 UTF-8 → chardetng 猜测（GB18030 等回退）。
pub fn decode_text(bytes: &[u8]) -> String {
    // UTF-8 BOM
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    // UTF-16 LE / BE BOM
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    // 严格 UTF-8：无损即直接返回
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    // 回退：用 chardetng 猜测（中文文档多为 GB18030），解码用猜到的编码
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let (cow, _, _) = enc.decode(bytes);
    cow.into_owned()
}

/// 列出白板 docs/ 目录下的 .md 文档（返回 DocRef，path 相对白板文件夹）。
pub fn list_docs(root: &Path, project_id: &str, board_id: &str) -> Result<Vec<DocRef>, String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    let dir = docs_dir(root, pid, bid);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取 docs 目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("遍历 docs 失败: {e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("md") && !ext.eq_ignore_ascii_case("markdown") {
            continue;
        }
        let fname = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let bytes = entry.metadata().ok().map(|m| m.len());
        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&fname)
            .to_string();
        out.push(DocRef {
            path: format!("docs/{fname}"),
            title,
            bytes,
        });
    }
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(out)
}

/// 导入一个文档：把源文件内容（已由前端读取为字节 / 或此处从磁盘读）复制进
/// 白板 docs/ 目录，重名时自动追加 -2 / -3。返回新建的 DocRef。
pub fn import_doc(
    root: &Path,
    project_id: &str,
    board_id: &str,
    src_path: &str,
) -> Result<DocRef, String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    let src = Path::new(src_path);
    let raw = fs::read(src).map_err(|e| format!("读取源文件失败: {e}"))?;
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("文档")
        .to_string();
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .filter(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or("md")
        .to_string();

    let dir = docs_dir(root, pid, bid);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 docs 目录失败: {e}"))?;

    // 重名处理
    let mut fname = format!("{stem}.{ext}");
    let mut n = 2;
    while dir.join(&fname).exists() {
        fname = format!("{stem}-{n}.{ext}");
        n += 1;
    }

    // 统一以 UTF-8（无 BOM）落盘，避免后续再探测
    let text = decode_text(&raw);
    let dst = dir.join(&fname);
    atomic_write(&dst, &text)?;
    let bytes = fs::metadata(&dst).ok().map(|m| m.len());

    Ok(DocRef {
        path: format!("docs/{fname}"),
        title: stem,
        bytes,
    })
}

/// 从字节内容创建一个文档（拖放场景：前端读到内容/或粘贴）。
pub fn write_doc(
    root: &Path,
    project_id: &str,
    board_id: &str,
    title: &str,
    content: &str,
) -> Result<DocRef, String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    let stem = title.trim();
    let stem = if stem.is_empty() { "未命名" } else { stem };
    // 文件名安全化：去掉分隔符
    let safe_stem: String = stem
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' { '_' } else { c })
        .collect();

    let dir = docs_dir(root, pid, bid);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 docs 目录失败: {e}"))?;

    let mut fname = format!("{safe_stem}.md");
    let mut n = 2;
    while dir.join(&fname).exists() {
        fname = format!("{safe_stem}-{n}.md");
        n += 1;
    }
    let dst = dir.join(&fname);
    atomic_write(&dst, content)?;
    let bytes = fs::metadata(&dst).ok().map(|m| m.len());
    Ok(DocRef {
        path: format!("docs/{fname}"),
        title: safe_stem,
        bytes,
    })
}

/// 读取白板 docs/ 下某文档，返回 UTF-8 文本（自动编码探测）。
pub fn read_doc(
    root: &Path,
    project_id: &str,
    board_id: &str,
    rel_path: &str,
) -> Result<String, String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    let name = rel_path.strip_prefix("docs/").unwrap_or(rel_path);
    let name = safe_doc_name(name)?;
    let p = docs_dir(root, pid, bid).join(&name);
    let raw = fs::read(&p).map_err(|e| format!("读取文档失败: {e}"))?;
    Ok(decode_text(&raw))
}

/// 解析并校验白板 docs/ 下某文档的绝对路径（供"用系统程序打开"等使用）。
// ─────────────────────────── AI 对话历史（M5） ───────────────────────────
//
// 每块白板的对话历史长期保存在白板文件夹下的 chats.json（与 docs/ 同级），
// 随白板整体复制/迁移。前端拥有其 JSON 结构，这里只做原子读写字符串。

pub fn chats_file(root: &Path, project_id: &str, board_id: &str) -> PathBuf {
    board_dir(root, project_id, board_id).join("chats.json")
}

/// 读取某白板的对话历史原始 JSON 文本；不存在则返回空串（前端按空处理）。
pub fn read_chats(root: &Path, project_id: &str, board_id: &str) -> Result<String, String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    let p = chats_file(root, pid, bid);
    if !p.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&p).map_err(|e| format!("读取对话历史失败: {e}"))
}

/// 原子写入某白板的对话历史 JSON 文本。
pub fn write_chats(
    root: &Path,
    project_id: &str,
    board_id: &str,
    content: &str,
) -> Result<(), String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    // 轻量校验：必须是合法 JSON，避免写坏文件
    serde_json::from_str::<serde_json::Value>(content)
        .map_err(|e| format!("对话历史不是合法 JSON: {e}"))?;
    atomic_write(&chats_file(root, pid, bid), content)
}

pub fn resolve_doc_path(
    root: &Path,
    project_id: &str,
    board_id: &str,
    rel_path: &str,
) -> Result<PathBuf, String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    let name = rel_path.strip_prefix("docs/").unwrap_or(rel_path);
    let name = safe_doc_name(name)?;
    let p = docs_dir(root, pid, bid).join(&name);
    if !p.exists() {
        return Err(format!("文件不存在：{}", p.display()));
    }
    Ok(p)
}

/// 删除白板 docs/ 下某文档。
pub fn delete_doc(
    root: &Path,
    project_id: &str,
    board_id: &str,
    rel_path: &str,
) -> Result<(), String> {
    let pid = safe_id(project_id)?;
    let bid = safe_id(board_id)?;
    let name = rel_path.strip_prefix("docs/").unwrap_or(rel_path);
    let name = safe_doc_name(name)?;
    let p = docs_dir(root, pid, bid).join(&name);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("删除文档失败: {e}"))?;
    }
    Ok(())
}

// ─────────────────────────── 单元测试 ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("lumen_test_{}_{}", tag, new_id("t")));
        fs::create_dir_all(&p).expect("创建临时目录");
        p
    }

    #[test]
    fn ensure_storage_creates_index() {
        let root = tmpdir("index");
        ensure_storage(&root).unwrap();
        let idx = index_path(&root);
        assert!(idx.exists(), "index.json 应被创建");
        let parsed = read_index(&root).unwrap();
        assert_eq!(parsed.version, FORMAT_VERSION);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_and_board_layout() {
        let root = tmpdir("layout");
        ensure_storage(&root).unwrap();

        let project = create_project(&root, "扩散模型").unwrap();
        assert!(project_file(&root, &project.id).exists(), "project.json 应存在");

        let board = create_board(&root, &project.id, "数学基础").unwrap();
        assert!(board_file(&root, &project.id, &board.id).exists(), "board.json 应存在");
        assert!(
            board_dir(&root, &project.id, &board.id).join("docs").is_dir(),
            "白板应自带 docs 目录"
        );

        // 写进去的结构要能原样读回
        let loaded = load_board(&root, &project.id, &board.id).unwrap();
        assert_eq!(loaded.name, "数学基础");
        assert_eq!(loaded.project_id, project.id);
        assert!(loaded.nodes.is_empty());
        assert!((loaded.viewport.zoom - 1.0).abs() < f64::EPSILON);

        // 项目里应能看到这块白板
        let pf = read_project(&root, &project.id).unwrap();
        assert_eq!(pf.boards.len(), 1);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_board_persists_changes() {
        let root = tmpdir("save");
        ensure_storage(&root).unwrap();
        let project = create_project(&root, "P").unwrap();
        let board = create_board(&root, &project.id, "B").unwrap();

        let mut loaded = load_board(&root, &project.id, &board.id).unwrap();
        loaded.name = "改过的名字".to_string();
        loaded.nodes.push(BoardNode {
            id: "n1".into(),
            title: "什么是 ELBO？".into(),
            summary: Some("变分下界的推导".into()),
            x: 240.0,
            y: 160.0,
            w: default_node_w(),
            color: None,
            docs: vec![DocRef {
                path: "docs/n1-elbo.md".into(),
                title: "GPT 回答".into(),
                bytes: Some(1024),
            }],
            created_at: now_iso(),
            updated_at: now_iso(),
        });
        save_board(&root, &loaded).unwrap();

        let reread = load_board(&root, &project.id, &board.id).unwrap();
        assert_eq!(reread.name, "改过的名字");
        assert_eq!(reread.nodes.len(), 1);
        assert_eq!(reread.nodes[0].title, "什么是 ELBO？");
        assert_eq!(reread.nodes[0].docs[0].path, "docs/n1-elbo.md");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn atomic_write_overwrites_and_cleans_temp() {
        let root = tmpdir("atomic");
        let file = root.join("board.json");
        atomic_write(&file, r#"{"a":1}"#).unwrap();
        atomic_write(&file, r#"{"a":2}"#).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), r#"{"a":2}"#);
        assert!(!root.join("board.json.tmp").exists(), "临时文件应已被改名移走");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn safe_id_blocks_path_traversal() {
        assert!(safe_id("p_abc123").is_ok());
        assert!(safe_id("b-1").is_ok());
        assert!(safe_id("../..").is_err(), "不能允许路径穿越");
        assert!(safe_id("a/b").is_err(), "不能允许路径分隔符");
        assert!(safe_id("..\\windows").is_err());
        assert!(safe_id("").is_err());
        assert!(safe_id(&"a".repeat(200)).is_err(), "超长 id 应被拒绝");
    }

    #[test]
    fn load_board_rejects_bad_id() {
        let root = tmpdir("badid");
        ensure_storage(&root).unwrap();
        assert!(load_board(&root, "../../etc", "b_1").is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_project_updates_index_and_file() {
        let root = tmpdir("renproj");
        ensure_storage(&root).unwrap();
        let p = create_project(&root, "旧名").unwrap();

        let updated = rename_project(&root, &p.id, "新名").unwrap();
        assert_eq!(updated.name, "新名");

        // index.json 与 project.json 都要改到
        let idx = read_index(&root).unwrap();
        assert_eq!(idx.projects.iter().find(|x| x.id == p.id).unwrap().name, "新名");
        assert_eq!(read_project(&root, &p.id).unwrap().name, "新名");

        assert!(rename_project(&root, &p.id, "   ").is_err(), "空名应被拒绝");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_board_updates_summary_and_body() {
        let root = tmpdir("renboard");
        ensure_storage(&root).unwrap();
        let p = create_project(&root, "P").unwrap();
        let b = create_board(&root, &p.id, "旧板").unwrap();

        let updated = rename_board(&root, &p.id, &b.id, "新板").unwrap();
        assert_eq!(updated.name, "新板");

        // project.json 的 boards[] 摘要与 board.json 本体都要改到
        let pf = read_project(&root, &p.id).unwrap();
        assert_eq!(pf.boards.iter().find(|x| x.id == b.id).unwrap().name, "新板");
        assert_eq!(load_board(&root, &p.id, &b.id).unwrap().name, "新板");

        assert!(rename_board(&root, &p.id, "../x", "y").is_err(), "非法 id 应被拒绝");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn decode_utf8_and_bom() {
        // 纯 UTF-8
        assert_eq!(decode_text("你好 world".as_bytes()), "你好 world");
        // 带 UTF-8 BOM
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice("标题".as_bytes());
        assert_eq!(decode_text(&with_bom), "标题");
    }

    #[test]
    fn decode_gb18030_fallback() {
        // “中文” 的 GB18030 编码字节
        let (bytes, _, _) = encoding_rs::GB18030.encode("中文测试");
        let decoded = decode_text(&bytes);
        assert_eq!(decoded, "中文测试");
    }

    #[test]
    fn import_read_list_delete_doc() {
        let root = tmpdir("docs");
        ensure_storage(&root).unwrap();
        let p = create_project(&root, "P").unwrap();
        let b = create_board(&root, &p.id, "B").unwrap();

        // 从字节写入两篇同名文档，验证重名处理
        let d1 = write_doc(&root, &p.id, &b.id, "笔记", "# 一\n内容").unwrap();
        let d2 = write_doc(&root, &p.id, &b.id, "笔记", "# 二\n内容").unwrap();
        assert_eq!(d1.path, "docs/笔记.md");
        assert_eq!(d2.path, "docs/笔记-2.md");

        // 列出
        let list = list_docs(&root, &p.id, &b.id).unwrap();
        assert_eq!(list.len(), 2);

        // 读取内容
        let content = read_doc(&root, &p.id, &b.id, "docs/笔记.md").unwrap();
        assert!(content.contains("# 一"));

        // 路径穿越应被拒绝
        assert!(read_doc(&root, &p.id, &b.id, "../../etc/passwd").is_err());

        // 删除
        delete_doc(&root, &p.id, &b.id, "docs/笔记.md").unwrap();
        assert_eq!(list_docs(&root, &p.id, &b.id).unwrap().len(), 1);

        fs::remove_dir_all(&root).ok();
    }
}

