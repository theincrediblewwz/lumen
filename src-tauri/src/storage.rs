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
}
