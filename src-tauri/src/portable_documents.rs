//! Complete desktop board packages; new identities on import, no replacement of existing boards.
use crate::{board_operations, commands, documents, storage, sync};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Cursor, Write},
    path::Path,
};
const LIMIT: usize = 96 * 1024 * 1024;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: String,
    files: BTreeMap<String, String>,
}
pub fn archive(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, bytes) in files {
        zip.start_file(
            path,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .map_err(err)?;
        zip.write_all(bytes).map_err(err)?;
    }
    Ok(zip.finish().map_err(err)?.into_inner())
}
fn is_markdown(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    path.ends_with(".md") || path.ends_with(".markdown")
}
fn knowledge_subset(
    root: &Path,
    board: &str,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<Value, String> {
    let path = root.join("knowledge/library.json");
    let mut library: Value = if path.exists() {
        serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?
    } else {
        json!({"version":1,"entries":[],"revisions":[],"bindings":[],"settings":[]})
    };
    crate::knowledge::validate(&library, &library)?;
    library["bindings"]
        .as_array_mut()
        .ok_or("知识引用无效")?
        .retain(|r| r["project_id"] == board);
    library["settings"] = json!([]);
    let mut selected = library["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["entry_id"].as_str().map(str::to_owned))
        .collect::<BTreeSet<_>>();
    for (path, bytes) in files {
        if !(is_markdown(path) || path == "chats.json") {
            continue;
        }
        let text = storage::decode_text(bytes);
        let prefix = "learnstuff-knowledge://";
        let mut cursor = 0;
        while let Some(found) = text[cursor..].find(prefix) {
            let start = cursor + found;
            let rest = &text[start + prefix.len()..];
            cursor = start + prefix.len();
            if !text[..start].ends_with('(') {
                continue;
            }
            let entry = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>();
            let Some(after) = rest.strip_prefix(&format!("{entry}/")) else {
                continue;
            };
            let revision = after
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>();
            if entry.is_empty() || revision.is_empty() {
                continue;
            }
            if !library["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["id"] == entry)
                || !library["revisions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["id"] == revision && r["entry_id"] == entry)
            {
                return Err(
                    "文档中的历史知识引用缺失，请先恢复知识库；尚未导出不完整资料包".into(),
                );
            }
            selected.insert(entry);
        }
    }
    loop {
        let before = selected.len();
        for row in library["entries"]
            .as_array()
            .ok_or("知识条目无效")?
            .iter()
            .chain(library["revisions"].as_array().ok_or("知识历史无效")?)
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
        if selected.len() == before {
            break;
        }
    }
    library["entries"]
        .as_array_mut()
        .unwrap()
        .retain(|r| selected.contains(r["id"].as_str().unwrap_or("")));
    library["revisions"]
        .as_array_mut()
        .unwrap()
        .retain(|r| selected.contains(r["entry_id"].as_str().unwrap_or("")));
    Ok(library)
}
pub fn export_at(root: &Path, p: &str, b: &str) -> Result<Vec<u8>, String> {
    let board = storage::load_board(root, p, b)?;
    let mut files = BTreeMap::from([(
        "board.json".into(),
        serde_json::to_vec_pretty(&board).map_err(err)?,
    )]);
    // Include orphaned local documents too: an older conversation or undo may reference them.
    for entry in fs::read_dir(storage::docs_dir(root, p, b)).map_err(err)? {
        let entry = entry.map_err(err)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "文档名不是UTF-8")?;
        let relative = format!("docs/{name}");
        let path = documents::doc_path(root, p, b, &relative)?;
        if entry.file_type().map_err(err)?.is_file() {
            files.insert(relative, fs::read(path).map_err(err)?);
        }
    }
    for name in ["chats.json", "chat-captures.json", "reading-positions.json"] {
        let path = board_operations::checked_path(root, &format!("{p}/{b}/{name}"))?;
        if path.exists() {
            files.insert(name.into(), fs::read(path).map_err(err)?);
        }
    }
    files.insert(
        "knowledge.json".into(),
        serde_json::to_vec(&knowledge_subset(root, b, &files)?).map_err(err)?,
    );
    validate_documents(&board, &files)?;
    if files.values().map(Vec::len).sum::<usize>() > LIMIT - 2 * 1024 * 1024 {
        return Err("白板资料包超过处理预算".into());
    }
    let manifest = Manifest {
        schema: "lumen.board-package/v1".into(),
        files: files
            .iter()
            .map(|(p, b)| (p.clone(), documents::hash(b)))
            .collect(),
    };
    files.insert(
        "lumen.package.json".into(),
        serde_json::to_vec_pretty(&manifest).map_err(err)?,
    );
    archive(&files)
}
fn validate_documents(
    board: &storage::BoardFile,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    let mut ids = BTreeSet::new();
    for n in &board.nodes {
        storage::safe_id(&n.id)?;
        if !ids.insert(&n.id) || !n.x.is_finite() || !n.y.is_finite() || !n.w.is_finite() {
            return Err("白板节点无效".into());
        }
        for doc in &n.docs {
            if !doc.path.starts_with("docs/")
                || !is_markdown(&doc.path)
                || !files.contains_key(&doc.path)
            {
                return Err("白板缺少挂载文档".into());
            }
        }
    }
    let mut edges = BTreeSet::new();
    for e in &board.edges {
        storage::safe_id(&e.id)?;
        if !edges.insert(&e.id) || !ids.contains(&e.from) || !ids.contains(&e.to) {
            return Err("白板连线无效".into());
        }
    }
    for (path, bytes) in files {
        if is_markdown(path) {
            for asset in documents::dependencies(bytes)? {
                let data = files.get(&asset.path).ok_or("资料包缺少图片或原件")?;
                if data.len() != asset.size || documents::hash(data) != asset.sha256 {
                    return Err("资料包附件校验失败".into());
                }
            }
        }
    }
    Ok(())
}
fn remap_links(text: &str, ids: &BTreeMap<String, String>) -> String {
    let mut result = text.to_string();
    for scheme in ["lumen://conversation/", "learnstuff-knowledge://"] {
        let mut offset = 0;
        while let Some(found) = result[offset..].find(scheme) {
            let start = offset + found;
            let end = result[start..]
                .find(|c: char| c.is_whitespace() || c == ')' || c == '>' || c == '"')
                .map(|n| n + start)
                .unwrap_or(result.len());
            let original = result[start..end].to_owned();
            let mut changed = original.clone();
            if scheme == "lumen://conversation/" {
                if let Ok(mut url) = reqwest::Url::parse(&original) {
                    let id = url.path().trim_start_matches('/');
                    if let Some(new) = ids.get(id) {
                        url.set_path(&format!("/{new}"));
                    }
                    let pairs = url
                        .query_pairs()
                        .map(|(key, value)| {
                            let value = if key == "messages" {
                                value
                                    .split(',')
                                    .map(|id| ids.get(id).cloned().unwrap_or(id.into()))
                                    .collect::<Vec<_>>()
                                    .join(",")
                            } else {
                                ids.get(value.as_ref())
                                    .cloned()
                                    .unwrap_or(value.into_owned())
                            };
                            (key.into_owned(), value)
                        })
                        .collect::<Vec<_>>();
                    url.query_pairs_mut().clear().extend_pairs(pairs);
                    changed = url.to_string();
                }
            } else {
                let rest = original.trim_start_matches(scheme);
                let parts = rest
                    .split('/')
                    .map(|id| ids.get(id).map(String::as_str).unwrap_or(id))
                    .collect::<Vec<_>>();
                changed = format!("{scheme}{}", parts.join("/"));
            }
            result.replace_range(start..end, &changed);
            offset = start + changed.len();
            if offset >= result.len() {
                break;
            }
        }
    }
    for (old, new) in ids {
        result = result.replace(&format!("[[node:{old}]]"), &format!("[[node:{new}]]"));
    }
    result
}
fn remap(value: &mut Value, ids: &BTreeMap<String, String>) {
    match value {
        Value::String(s) => *s = remap_links(s, ids),
        Value::Array(rows) => {
            for row in rows {
                remap(row, ids)
            }
        }
        Value::Object(obj) => {
            for (key, row) in obj {
                if key == "id"
                    || key.ends_with("_id")
                    || key.ends_with("Id")
                    || matches!(key.as_str(), "from" | "to" | "project" | "board")
                {
                    if let Some(new) = row.as_str().and_then(|s| ids.get(s)) {
                        *row = json!(new);
                        continue;
                    }
                }
                if matches!(key.as_str(), "message_ids_json" | "basis_json") {
                    let mut list: Vec<String> =
                        serde_json::from_str(row.as_str().unwrap_or("[]")).unwrap_or_default();
                    for id in &mut list {
                        if let Some(new) = ids.get(id) {
                            *id = new.clone();
                        }
                    }
                    *row = json!(serde_json::to_string(&list).unwrap());
                    continue;
                }
                if key == "selection_key" {
                    if let Some(s) = row.as_str() {
                        let mapped = s
                            .split(':')
                            .map(|part| {
                                part.split(',')
                                    .map(|id| ids.get(id).map(String::as_str).unwrap_or(id))
                                    .collect::<Vec<_>>()
                                    .join(",")
                            })
                            .collect::<Vec<_>>()
                            .join(":");
                        *row = json!(mapped);
                    }
                    continue;
                }
                remap(row, ids);
            }
        }
        _ => {}
    }
}
fn map_id(ids: &mut BTreeMap<String, String>, id: &str, prefix: &str) -> Result<(), String> {
    storage::safe_id(id)?;
    if ids.contains_key(id) {
        return Err("资料包标识跨类型重复，未导入".into());
    }
    ids.insert(id.into(), storage::new_id(prefix));
    Ok(())
}
pub fn import_at(root: &Path, p: &str, bytes: &[u8]) -> Result<storage::BoardFile, String> {
    storage::safe_id(p)?;
    let mut project = storage::read_project(root, p)?;
    let mut files = documents::unzip_limit(bytes, LIMIT, 10000)?;
    let manifest: Manifest = serde_json::from_slice(
        &files
            .remove("lumen.package.json")
            .ok_or("这不是 Lumen 白板资料包；图文 ZIP 请拖到节点")?,
    )
    .map_err(err)?;
    if manifest.schema != "lumen.board-package/v1" || manifest.files.len() != files.len() {
        return Err("资料包清单不完整".into());
    }
    for (path, data) in &files {
        if manifest.files.get(path) != Some(&documents::hash(data)) {
            return Err("资料包文件哈希不符，未导入".into());
        }
        if path != "board.json"
            && path != "knowledge.json"
            && path != "chats.json"
            && path != "chat-captures.json"
            && path != "reading-positions.json"
            && !path.starts_with("docs/")
        {
            return Err("资料包包含未知文件".into());
        }
        if path.starts_with("docs/") {
            documents::doc_path(root, p, "validation", path)?;
        }
    }
    let mut board: storage::BoardFile =
        serde_json::from_slice(files.get("board.json").ok_or("缺少白板")?).map_err(err)?;
    validate_documents(&board, &files)?;
    if board.id == board.project_id {
        return Err("资料包项目和白板标识冲突".into());
    }
    let new_board_id = storage::new_id("b");
    let mut ids = BTreeMap::from([
        (board.id.clone(), new_board_id.clone()),
        (board.project_id.clone(), p.into()),
    ]);
    for node in &board.nodes {
        map_id(&mut ids, &node.id, "n")?;
    }
    for edge in &board.edges {
        map_id(&mut ids, &edge.id, "e")?;
    }
    if let Some(bytes) = files.get("chats.json") {
        let chat: Value = serde_json::from_slice(bytes).map_err(err)?;
        for c in chat["conversations"].as_array().ok_or("对话格式无效")? {
            if let Some(id) = c["id"].as_str() {
                map_id(&mut ids, id, "c")?;
            }
            for m in c["messages"].as_array().ok_or("消息格式无效")? {
                if let Some(id) = m["id"].as_str() {
                    map_id(&mut ids, id, "m")?;
                }
            }
        }
    }
    let mut library: Value =
        serde_json::from_slice(files.get("knowledge.json").ok_or("缺少知识引用清单")?)
            .map_err(err)?;
    for binding in library["bindings"].as_array().ok_or("知识引用清单无效")? {
        if binding["project_id"] != board.id
            || (!binding["node_id"].is_null()
                && !board.nodes.iter().any(|n| binding["node_id"] == n.id))
        {
            return Err("知识引用不属于导入白板".into());
        }
    }
    for name in ["chat-captures.json", "reading-positions.json"] {
        if let Some(raw) = files.get(name) {
            let rows: Value = serde_json::from_slice(raw).map_err(err)?;
            for row in rows.as_array().ok_or("文档来源清单无效")? {
                if let Some(id) = row["id"].as_str() {
                    map_id(&mut ids, id, "ref")?;
                }
            }
        }
    }
    for table in ["entries", "revisions", "bindings"] {
        for row in library[table].as_array().ok_or("知识清单无效")? {
            let id = row["id"].as_str().ok_or("知识缺少标识")?;
            map_id(&mut ids, id, "k")?;
        }
    }
    // basis_json is intentionally a string in the shared protocol.
    for table in ["entries", "revisions"] {
        for row in library[table].as_array_mut().unwrap() {
            let mut basis: Value =
                serde_json::from_str(row["basis_json"].as_str().unwrap_or("[]")).map_err(err)?;
            remap(&mut basis, &ids);
            row["basis_json"] = json!(serde_json::to_string(&basis).map_err(err)?);
        }
    }
    remap(&mut library, &ids);
    let library_path = root.join("knowledge/library.json");
    let previous: Value = if library_path.exists() {
        serde_json::from_slice(&fs::read(library_path).map_err(err)?).map_err(err)?
    } else {
        json!({"version":1,"entries":[],"revisions":[],"bindings":[],"settings":[]})
    };
    let mut merged = previous.clone();
    for table in ["entries", "revisions", "bindings"] {
        merged[table]
            .as_array_mut()
            .ok_or("本地知识清单无效")?
            .extend(library[table].as_array().unwrap().clone());
    }
    crate::knowledge::validate(&merged, &previous)?;
    board.id = new_board_id;
    board.project_id = p.into();
    board.name = format!("{}（导入）", board.name);
    board.created_at = storage::now_iso();
    board.updated_at = board.created_at.clone();
    board.extra.remove("_disk_revision");
    if storage::board_dir(root, p, &board.id).exists()
        || project.boards.iter().any(|b| b.id == board.id)
    {
        return Err("新白板路径已存在，未覆盖资料".into());
    }
    for node in &mut board.nodes {
        node.id = ids[&node.id].clone();
    }
    for edge in &mut board.edges {
        edge.id = ids[&edge.id].clone();
        edge.from = ids[&edge.from].clone();
        edge.to = ids[&edge.to].clone();
    }
    let mut writes = BTreeMap::new();
    for (path, data) in files {
        if path == "board.json" || path == "knowledge.json" {
            continue;
        }
        let bytes = if path.ends_with(".json") {
            let mut value: Value = serde_json::from_slice(&data).map_err(err)?;
            remap(&mut value, &ids);
            serde_json::to_vec(&value).map_err(err)?
        } else if is_markdown(&path) {
            let text = String::from_utf8(data).map_err(err)?;
            let mut value = json!(text);
            remap(&mut value, &ids);
            value.as_str().unwrap().as_bytes().to_vec()
        } else {
            data
        };
        writes.insert(format!("{p}/{}/{path}", board.id), bytes);
    }
    project.boards.push(storage::BoardMeta {
        id: board.id.clone(),
        name: board.name.clone(),
        updated_at: board.updated_at.clone(),
    });
    project.updated_at = board.updated_at.clone();
    writes.insert(
        format!("{p}/project.json"),
        serde_json::to_vec_pretty(&project).map_err(err)?,
    );
    writes.insert(
        format!("{p}/{}/board.json", board.id),
        serde_json::to_vec_pretty(&board).map_err(err)?,
    );
    writes.insert(
        "knowledge/library.json".into(),
        serde_json::to_vec(&merged).map_err(err)?,
    );
    sync::transaction(root, writes)?;
    Ok(board)
}
#[tauri::command]
pub async fn board_package_export(
    project_id: String,
    board_id: String,
    destination: String,
    expected_scope: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _g = sync::IO_LOCK.lock().map_err(err)?;
        let root = commands::root()?;
        board_operations::ensure_scope(&root, &expected_scope)?;
        if Path::new(&destination).extension().and_then(|s| s.to_str()) != Some("zip") {
            return Err("请选择 .zip 文件".into());
        }
        let target = board_operations::external_destination(&root, &destination)?;
        sync::atomic_bytes(&target, &export_at(&root, &project_id, &board_id)?)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn board_package_import(
    project_id: String,
    src_path: String,
    expected_scope: String,
) -> Result<storage::BoardFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if fs::metadata(&src_path).map_err(err)?.len() > LIMIT as u64 {
            return Err("资料包超过96MiB".into());
        }
        let bytes = fs::read(&src_path).map_err(err)?;
        let _g = sync::IO_LOCK.lock().map_err(err)?;
        let root = commands::root()?;
        board_operations::ensure_scope(&root, &expected_scope)?;
        import_at(&root, &project_id, &bytes)
    })
    .await
    .map_err(err)?
}
