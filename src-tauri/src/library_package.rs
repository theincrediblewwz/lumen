//! Streaming content archives. Restore creates a new library; never merges into or replaces the live one.
use crate::{board_operations as safety, commands, documents, knowledge, storage, sync};
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;
const SCHEMA: &str = "lumen.library-package/v1";
const MANIFEST: &str = "lumen-library.json";
const MAX_TOTAL: u64 = 1024 * 1024 * 1024 * 1024;
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn available_space(path: &Path) -> Result<u64, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                path: *const u16,
                available: *mut u64,
                total: *mut u64,
                free: *mut u64,
            ) -> i32;
        }
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut available = 0;
        if unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(available)
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(err)?;
        let mut result = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::statvfs(path.as_ptr(), result.as_mut_ptr()) } != 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        let result = unsafe { result.assume_init() };
        Ok((result.f_bavail as u64).saturating_mul(result.f_frsize as u64))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        Err("当前平台不能检查恢复空间".into())
    }
}
fn ensure_space(path: &Path, bytes: u64) -> Result<(), String> {
    if available_space(path)? < bytes.saturating_add(64 * 1024 * 1024) {
        return Err(
            "所选目录空间不足，需为完整原件和临时写入预留空间；原库及旧备份未改动。".into(),
        );
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    sha256: String,
    size: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: String,
    kind: String,
    created_at: String,
    files: BTreeMap<String, Entry>,
}
enum Source {
    File(PathBuf),
    Bytes(Vec<u8>),
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn normalized(path: &str) -> String {
    path.nfc().flat_map(char::to_lowercase).collect()
}
fn claim(path: &str, names: &mut BTreeMap<String, String>) -> Result<(), String> {
    let mut prefix = String::new();
    for segment in path.split('/') {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(segment);
        let folded = normalized(&prefix);
        if names.get(&folded).is_some_and(|old| old != &prefix) {
            return Err("资料路径存在大小写或Unicode目录冲突".into());
        }
        names.insert(folded, prefix.clone());
    }
    Ok(())
}
fn safe_name(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 || path.starts_with('/') || path.contains('\\') {
        return Err("资料包路径无效".into());
    }
    for name in path.split('/') {
        let stem = name.split('.').next().unwrap_or("").to_uppercase();
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.len() > 255
            || name.ends_with(['.', ' '])
            || name
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
            || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && "123456789".contains(stem.chars().last().unwrap())
        {
            return Err("资料包含不安全或不兼容的文件名".into());
        }
    }
    Ok(())
}
fn add_file(root: &Path, path: &str, files: &mut BTreeMap<String, Source>) -> Result<(), String> {
    safe_name(path)?;
    let source = safety::checked_path(root, path)?;
    if !fs::metadata(&source).map_err(err)?.is_file() {
        return Err("资料包含非普通文件".into());
    }
    files.insert(path.into(), Source::File(source));
    Ok(())
}
fn add_tree(
    root: &Path,
    relative: &str,
    files: &mut BTreeMap<String, Source>,
) -> Result<(), String> {
    let path = safety::checked_path(root, relative)?;
    if !path.exists() {
        return Ok(());
    }
    let mut pending = vec![relative.to_string()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(safety::checked_path(root, &dir)?).map_err(err)? {
            let entry = entry.map_err(err)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "资料文件名不是UTF-8")?;
            let next = format!("{dir}/{name}");
            safe_name(&next)?;
            let path = safety::checked_path(root, &next)?;
            let kind = fs::symlink_metadata(path).map_err(err)?.file_type();
            if kind.is_dir() {
                pending.push(next);
            } else if kind.is_file() {
                add_file(root, &next, files)?;
            } else {
                return Err("资料目录含链接或特殊文件，未生成不完整备份".into());
            }
        }
    }
    Ok(())
}
fn read_source(source: &Source) -> Result<Vec<u8>, String> {
    match source {
        Source::File(path) => fs::read(path).map_err(err),
        Source::Bytes(bytes) => Ok(bytes.clone()),
    }
}
// Historical Markdown is stored as byte arrays. Scan it through serde visitors,
// skipping binary originals, instead of expanding a large backup into Value arrays.
struct History<'a> {
    selected: &'a mut BTreeSet<String>,
    files: bool,
}
impl<'de> DeserializeSeed<'de> for History<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for History<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "a board backup map")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(key) = map.next_key::<String>()? {
            if !self.files && key == "files" {
                map.next_value_seed(History {
                    selected: self.selected,
                    files: true,
                })?;
            } else if self.files
                && (key.to_ascii_lowercase().ends_with(".md")
                    || key.to_ascii_lowercase().ends_with(".markdown"))
            {
                map.next_value_seed(HistoryText(self.selected))?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(())
    }
}
struct HistoryText<'a>(&'a mut BTreeSet<String>);
impl<'de> DeserializeSeed<'de> for HistoryText<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for HistoryText<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "historical Markdown bytes")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let prefix = b"learnstuff-knowledge://";
        let mut matched = 0;
        let mut id = String::new();
        let mut capturing = false;
        while let Some(byte) = seq.next_element::<u8>()? {
            if capturing {
                if byte.is_ascii_alphanumeric() || b"_-".contains(&byte) {
                    if id.len() < 128 {
                        id.push(byte as char);
                    }
                    continue;
                }
                if !id.is_empty() {
                    self.0.insert(std::mem::take(&mut id));
                }
                capturing = false;
            }
            if byte == prefix[matched] {
                matched += 1;
                if matched == prefix.len() {
                    capturing = true;
                    matched = 0;
                }
            } else {
                matched = usize::from(byte == prefix[0]);
            }
        }
        if capturing && !id.is_empty() {
            self.0.insert(id);
        }
        Ok(())
    }
}
fn collect(
    root: &Path,
    project: Option<&str>,
    preferences: Value,
) -> Result<(BTreeMap<String, Source>, usize, usize), String> {
    safety::checked_path(root, "index.json")?;
    let mut index = storage::read_index(root)?;
    if let Some(id) = project {
        storage::safe_id(id)?;
        index.projects.retain(|row| row.id == id);
        if index.projects.len() != 1 {
            return Err("待导出项目不存在".into());
        }
    }
    let mut files = BTreeMap::new();
    let mut boards = BTreeSet::new();
    let mut project_ids = BTreeSet::new();
    files.insert(
        "index.json".into(),
        if project.is_none() {
            Source::File(safety::checked_path(root, "index.json")?)
        } else {
            Source::Bytes(serde_json::to_vec_pretty(&index).map_err(err)?)
        },
    );
    for meta in &index.projects {
        storage::safe_id(&meta.id)?;
        if !project_ids.insert(meta.id.clone()) {
            return Err("项目索引有重复标识".into());
        }
        safety::checked_path(root, &format!("{}/project.json", meta.id))?;
        let p = storage::read_project(root, &meta.id)?;
        if p.id != meta.id || p.version != 1 {
            return Err("项目索引不一致".into());
        }
        add_file(root, &format!("{}/project.json", meta.id), &mut files)?;
        add_tree(
            root,
            &format!("{}/.conversation-imports", meta.id),
            &mut files,
        )?;
        for board in p.boards {
            storage::safe_id(&board.id)?;
            if !boards.insert(board.id.clone()) {
                return Err("白板标识重复".into());
            }
            let base = format!("{}/{}", meta.id, board.id);
            add_file(root, &format!("{base}/board.json"), &mut files)?;
            for name in [
                "chats.json",
                "chat-captures.json",
                "reading-positions.json",
                ".chat-deleted.json",
            ] {
                let path = format!("{base}/{name}");
                if safety::checked_path(root, &path)?.exists() {
                    add_file(root, &path, &mut files)?;
                }
            }
            for name in ["docs", ".ai-backups", ".snapshots", ".chat-trash"] {
                add_tree(root, &format!("{base}/{name}"), &mut files)?;
            }
        }
    }
    let path = safety::checked_path(root, "knowledge/library.json")?;
    if path.exists() {
        if project.is_none() {
            files.insert("knowledge/library.json".into(), Source::File(path));
        } else {
            let mut library: Value =
                serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
            knowledge::validate(&library, &library)?;
            library["bindings"]
                .as_array_mut()
                .unwrap()
                .retain(|row| boards.contains(row["project_id"].as_str().unwrap_or("")));
            library["settings"]
                .as_array_mut()
                .unwrap()
                .retain(|row| boards.contains(row["project_id"].as_str().unwrap_or("")));
            let mut selected = library["bindings"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|row| row["entry_id"].as_str().map(str::to_owned))
                .collect::<BTreeSet<_>>();
            let scan = |text: &str, selected: &mut BTreeSet<String>| {
                for suffix in text.split("learnstuff-knowledge://").skip(1) {
                    let id = suffix
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric() || ['_', '-'].contains(c))
                        .collect::<String>();
                    if !id.is_empty() {
                        selected.insert(id);
                    }
                }
            };
            for (path, source) in &files {
                if path.contains("/.ai-backups/") {
                    if let Source::File(file) = source {
                        let reader = std::io::BufReader::new(fs::File::open(file).map_err(err)?);
                        History {
                            selected: &mut selected,
                            files: false,
                        }
                        .deserialize(&mut serde_json::Deserializer::from_reader(reader))
                        .map_err(err)?;
                    }
                } else if path.to_ascii_lowercase().ends_with(".md")
                    || path.to_ascii_lowercase().ends_with(".markdown")
                    || path.ends_with(".json")
                {
                    let bytes = read_source(source)?;
                    scan(&storage::decode_text(&bytes), &mut selected);
                }
            }
            loop {
                let before = selected.len();
                for row in library["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .chain(library["revisions"].as_array().unwrap())
                {
                    if selected.contains(
                        row["entry_id"]
                            .as_str()
                            .or(row["id"].as_str())
                            .unwrap_or(""),
                    ) {
                        let basis: Vec<String> =
                            serde_json::from_str(row["basis_json"].as_str().unwrap_or("[]"))
                                .map_err(err)?;
                        selected.extend(basis);
                    }
                }
                if before == selected.len() {
                    break;
                }
            }
            if selected.iter().any(|id| {
                !library["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["id"].as_str() == Some(id))
            }) {
                return Err("项目历史引用的知识尚未到齐，未导出不完整项目包".into());
            }
            library["entries"]
                .as_array_mut()
                .unwrap()
                .retain(|row| selected.contains(row["id"].as_str().unwrap_or("")));
            library["revisions"]
                .as_array_mut()
                .unwrap()
                .retain(|row| selected.contains(row["entry_id"].as_str().unwrap_or("")));
            files.insert(
                "knowledge/library.json".into(),
                Source::Bytes(serde_json::to_vec(&library).map_err(err)?),
            );
        }
    }
    if !preferences.is_null() {
        let map = preferences.as_object().ok_or("显示偏好格式无效")?;
        if map
            .keys()
            .any(|key| !["ui", "reader", "progress"].contains(&key.as_str()))
        {
            return Err("只允许备份显示和阅读偏好".into());
        }
        let bytes = serde_json::to_vec(&preferences).map_err(err)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("阅读偏好超过16MiB预算，未截断".into());
        }
        files.insert("reading-preferences.json".into(), Source::Bytes(bytes));
    }
    Ok((files, index.projects.len(), boards.len()))
}
pub(crate) fn export_at(
    root: &Path,
    project: Option<&str>,
    target: &Path,
    preferences: Value,
    progress: impl Fn(usize, usize),
) -> Result<Value, String> {
    let (files, projects, boards) = collect(root, project, preferences)?;
    let total = files.len();
    let mut folded = BTreeMap::new();
    for path in files.keys() {
        claim(path, &mut folded)?;
    }
    let required = files
        .values()
        .try_fold(0u64, |total, source| -> Result<u64, String> {
            let size = match source {
                Source::File(path) => fs::metadata(path).map_err(err)?.len(),
                Source::Bytes(bytes) => bytes.len() as u64,
            };
            total.checked_add(size).ok_or("资料包过大".into())
        })?;
    ensure_space(target.parent().ok_or("导出位置无效")?, required)?;
    let temp = target.with_extension(format!("{}.tmp", storage::new_id("package")));
    let file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(err)?;
    let guard = Temporary(temp.clone());
    let mut zip = zip::ZipWriter::new(file);
    let mut manifest = Manifest {
        schema: SCHEMA.into(),
        kind: if project.is_some() {
            "project"
        } else {
            "library"
        }
        .into(),
        created_at: storage::now_iso(),
        files: BTreeMap::new(),
    };
    let mut total_bytes = 0u64;
    let mut buffer = vec![0u8; 64 * 1024];
    for (index, (path, source)) in files.into_iter().enumerate() {
        let mut reader: Box<dyn Read> = match source {
            Source::File(path) => Box::new(fs::File::open(path).map_err(err)?),
            Source::Bytes(bytes) => Box::new(std::io::Cursor::new(bytes)),
        };
        zip.start_file(
            format!("data/{path}"),
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(err)?;
        let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
        let mut size = 0u64;
        loop {
            let count = reader.read(&mut buffer).map_err(err)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            total_bytes = total_bytes.checked_add(count as u64).ok_or("资料包过大")?;
            if total_bytes > MAX_TOTAL {
                return Err("资料包超过1TiB处理预算，未生成不完整包".into());
            }
            digest.update(&buffer[..count]);
            zip.write_all(&buffer[..count]).map_err(err)?;
        }
        manifest.files.insert(
            path,
            Entry {
                sha256: digest
                    .finish()
                    .as_ref()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect(),
                size,
            },
        );
        progress(index + 1, total);
    }
    validate_attachments(root, &manifest.files)?;
    zip.start_file(MANIFEST, zip::write::SimpleFileOptions::default())
        .map_err(err)?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(err)?)
        .map_err(err)?;
    zip.finish().map_err(err)?.sync_all().map_err(err)?;
    sync::commit_temp_file(&temp, target)?;
    drop(guard);
    Ok(json!({"projects":projects,"boards":boards,"files":total,"bytes":total_bytes,"path":target}))
}
fn validate_attachments(root: &Path, files: &BTreeMap<String, Entry>) -> Result<(), String> {
    for path in files.keys() {
        if path.to_ascii_lowercase().ends_with(".md")
            || path.to_ascii_lowercase().ends_with(".markdown")
        {
            let raw =
                storage::decode_text(&fs::read(safety::checked_path(root, path)?).map_err(err)?);
            let (metadata, _) = documents::split(&raw)?;
            if let Some(metadata) = metadata {
                let (base, _) = path.rsplit_once("/docs/").ok_or("挂载正文路径无效")?;
                for asset in documents::assets(&metadata) {
                    let entry = files
                        .get(&format!("{base}/{}", asset.path))
                        .ok_or("PDF或图片原件缺失，未生成不完整资料包")?;
                    if entry.sha256 != asset.sha256 || entry.size != asset.size as u64 {
                        return Err("挂载原件的大小或摘要不一致".into());
                    }
                }
            }
        }
    }
    Ok(())
}
fn valid_library(root: &Path, files: &BTreeMap<String, Entry>) -> Result<(), String> {
    validate_attachments(root, files)?;
    let index = storage::read_index(root)?;
    if index.version != 1 {
        return Err("资料索引版本不受支持".into());
    }
    let mut seen = BTreeSet::new();
    let mut boards = BTreeMap::new();
    let mut owners = BTreeMap::new();
    for meta in index.projects {
        storage::safe_id(&meta.id)?;
        if !seen.insert(meta.id.clone()) {
            return Err("项目标识重复".into());
        }
        let project = storage::read_project(root, &meta.id)?;
        if project.id != meta.id || project.version != 1 {
            return Err("项目归属或版本无效".into());
        }
        for item in project.boards {
            storage::safe_id(&item.id)?;
            let board = storage::load_board(root, &meta.id, &item.id)?;
            if board.id != item.id || board.project_id != meta.id || boards.contains_key(&item.id) {
                return Err("白板归属或标识无效".into());
            }
            let mut nodes = BTreeSet::new();
            for node in &board.nodes {
                storage::safe_id(&node.id)?;
                if !nodes.insert(node.id.clone()) {
                    return Err("节点标识重复".into());
                }
                for doc in &node.docs {
                    documents::doc_path(root, &meta.id, &item.id, &doc.path)?;
                    if !files.contains_key(&format!("{}/{}/{}", meta.id, item.id, doc.path)) {
                        return Err("挂载文档缺失，恢复尚未提交".into());
                    }
                }
            }
            if board
                .edges
                .iter()
                .any(|edge| !nodes.contains(&edge.from) || !nodes.contains(&edge.to))
            {
                return Err("连线引用了缺失节点".into());
            }
            owners.insert(item.id.clone(), meta.id.clone());
            boards.insert(item.id.clone(), serde_json::to_vec(&board).map_err(err)?);
        }
    }
    for path in files.keys() {
        if [
            "index.json",
            "knowledge/library.json",
            "reading-preferences.json",
        ]
        .contains(&path.as_str())
        {
            continue;
        }
        let parts = path.split('/').collect::<Vec<_>>();
        if !seen.contains(parts[0])
            || parts.len() > 2
                && parts[1] != ".conversation-imports"
                && owners.get(parts[1]).map(String::as_str) != Some(parts[0])
        {
            return Err("资料包文件不属于已登记的项目/白板".into());
        }
    }
    let path = root.join("knowledge/library.json");
    if path.exists() {
        let mut library: Value =
            serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
        knowledge::validate(&library, &library)?;
        // Board deletion intentionally retains independent knowledge. Match the
        // live loader's ownership projection without editing archival bytes.
        for table in ["bindings", "settings"] {
            library[table].as_array_mut().unwrap().retain(|row| {
                boards
                    .get(row["project_id"].as_str().unwrap_or(""))
                    .is_some_and(|bytes| {
                        if table == "settings" || row["node_id"].is_null() {
                            return true;
                        }
                        serde_json::from_slice::<Value>(bytes).is_ok_and(|board| {
                            board["nodes"].as_array().is_some_and(|nodes| {
                                nodes.iter().any(|node| node["id"] == row["node_id"])
                            })
                        })
                    })
            });
        }
        let graph = boards
            .into_iter()
            .map(|(id, bytes)| (format!("check/{id}/board.json"), bytes))
            .collect();
        knowledge::validate_ownership(&library, &graph)?;
    }
    Ok(())
}
pub(crate) fn restore_at(source: &Path, parent: &Path) -> Result<Value, String> {
    let file = fs::File::open(source).map_err(err)?;
    let mut zip = zip::ZipArchive::new(file).map_err(err)?;
    let manifest: Manifest = {
        let mut item = zip
            .by_name(MANIFEST)
            .map_err(|_| "不是Lumen项目/全库资料包")?;
        if item.size() > 64 * 1024 * 1024 {
            return Err("资料包清单超过64MiB预算".into());
        }
        let mut bytes = Vec::new();
        (&mut item)
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        serde_json::from_slice(&bytes).map_err(err)?
    };
    if manifest.schema != SCHEMA
        || !["project", "library"].contains(&manifest.kind.as_str())
        || !manifest.files.contains_key("index.json")
        || zip.len() != manifest.files.len() + 1
    {
        return Err("资料包版本、清单或文件数量不一致".into());
    }
    let mut names = BTreeSet::new();
    let mut prefixes = BTreeMap::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(err)?;
        let name = entry.name().map_err(err)?.into_owned();
        safe_name(&name)?;
        if entry.is_dir()
            || entry.is_symlink()
            || entry.encrypted()
            || !names.insert(normalized(&name))
        {
            return Err("资料包含链接、目录、加密或重复路径".into());
        }
        claim(&name, &mut prefixes)?;
        if name == MANIFEST {
            continue;
        }
        let key = name.strip_prefix("data/").ok_or("资料包路径不在数据区")?;
        let expected = manifest.files.get(key).ok_or("清单以外的文件")?;
        if expected.size != entry.size() || expected.sha256.len() != 64 {
            return Err("文件大小或摘要无效".into());
        }
        total = total.checked_add(expected.size).ok_or("资料包过大")?;
        if total > MAX_TOTAL {
            return Err("解压内容超过1TiB处理预算".into());
        }
        let segments = key.split('/').collect::<Vec<_>>();
        let allowed = key == "index.json"
            || key == "knowledge/library.json"
            || key == "reading-preferences.json"
            || segments.len() == 2 && segments[1] == "project.json"
            || segments.len() >= 3 && segments[1] == ".conversation-imports"
            || segments.len() == 3
                && [
                    "board.json",
                    "chats.json",
                    "chat-captures.json",
                    "reading-positions.json",
                    ".chat-deleted.json",
                ]
                .contains(&segments[2])
            || segments.len() >= 4
                && ["docs", ".ai-backups", ".snapshots", ".chat-trash"].contains(&segments[2]);
        if !allowed {
            return Err("资料包含连接配置或不支持的数据路径".into());
        }
        if ![
            "index.json",
            "knowledge/library.json",
            "reading-preferences.json",
        ]
        .contains(&key)
        {
            storage::safe_id(segments[0])?;
        }
    }
    let parent = parent.canonicalize().map_err(err)?;
    ensure_space(&parent, total)?;
    let id = storage::new_id("restore");
    let stage = parent.join(format!(".lumen-{id}"));
    fs::create_dir(&stage).map_err(err)?;
    let guard = Staging(stage.clone());
    let mut buffer = vec![0u8; 64 * 1024];
    for (path, entry) in &manifest.files {
        let target = safety::checked_path(&stage, path)?;
        fs::create_dir_all(target.parent().ok_or("目标目录无效")?).map_err(err)?;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)
            .map_err(err)?;
        let mut raw = zip.by_name(&format!("data/{path}")).map_err(err)?;
        let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
        let mut size = 0u64;
        loop {
            let count = raw.read(&mut buffer).map_err(err)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > entry.size {
                return Err("解压文件超过清单大小".into());
            }
            digest.update(&buffer[..count]);
            file.write_all(&buffer[..count]).map_err(err)?;
        }
        file.sync_all().map_err(err)?;
        let hash: String = digest
            .finish()
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if size != entry.size || hash != entry.sha256 {
            return Err("资料包校验失败，原库未改动".into());
        }
    }
    valid_library(&stage, &manifest.files)?;
    let preferences = if stage.join("reading-preferences.json").exists() {
        serde_json::from_slice(&fs::read(stage.join("reading-preferences.json")).map_err(err)?)
            .map_err(err)?
    } else {
        Value::Null
    };
    let target = parent.join(format!("Lumen-{id}"));
    if target.exists() {
        return Err("恢复目标已存在，未覆盖".into());
    }
    fs::rename(&stage, &target).map_err(err)?;
    drop(guard);
    Ok(
        json!({"root":target,"preferences":preferences,"kind":manifest.kind,"files":manifest.files.len()}),
    )
}
#[tauri::command]
pub async fn library_package_export(
    window: tauri::WebviewWindow,
    project_id: Option<String>,
    destination: String,
    expected_scope: String,
    preferences: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let _lock = sync::IO_LOCK.lock().map_err(err)?;
        let root = commands::root()?;
        safety::ensure_scope(&root, &expected_scope)?;
        if !Path::new(&destination)
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("zip"))
        {
            return Err("请选择.zip文件导出".into());
        }
        let target = safety::external_destination(&root, &destination)?;
        export_at(
            &root,
            project_id.as_deref(),
            &target,
            preferences,
            |done, total| {
                let _ = window.emit(
                    "lumen://archive-progress",
                    json!({"done":done,"total":total}),
                );
            },
        )
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn library_package_restore(
    src_path: String,
    parent_path: String,
    expected_scope: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = sync::IO_LOCK.lock().map_err(err)?;
        let root = commands::root()?;
        safety::ensure_scope(&root, &expected_scope)?;
        let parent = Path::new(&parent_path).canonicalize().map_err(err)?;
        if parent.starts_with(root.canonicalize().map_err(err)?) {
            return Err("请选择原资料库以外的位置恢复，原库会保留".into());
        }
        restore_at(Path::new(&src_path), &parent)
    })
    .await
    .map_err(err)?
}
