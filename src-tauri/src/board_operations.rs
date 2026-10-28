//! Bounded, additive board writes. Permission is device-local; before-images are durable.
use crate::{commands, config, storage, sync};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    hash::{Hash, Hasher},
    path::Path,
};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub enabled: bool,
    pub revision: u64,
    pub keep: usize,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            enabled: false,
            revision: 0,
            keep: 20,
        }
    }
}
pub(crate) fn policy_at(dir: &Path) -> Result<Policy, String> {
    let p = dir.join("board-write-policy.json");
    if !p.exists() {
        return Ok(Policy::default());
    }
    let v: Policy = serde_json::from_slice(&fs::read(p).map_err(err)?).map_err(err)?;
    if !(1..=100).contains(&v.keep) {
        return Err("备份份数须为1–100".into());
    }
    Ok(v)
}
pub(crate) fn scope(root: &Path) -> Result<String, String> {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    fs::canonicalize(root).map_err(err)?.hash(&mut hash);
    Ok(format!("{:016x}", hash.finish()))
}
pub(crate) fn ensure_scope(root: &Path, expected: &str) -> Result<(), String> {
    if scope(root)? != expected { return Err("资料目录已变化，原对话仍保留，本次未读取或写入新目录。".into()); }
    Ok(())
}
#[tauri::command]
pub fn board_write_policy_get() -> Result<Value, String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    Ok(
        json!({"policy":policy_at(&config::config_dir()?)?,"scope":commands::root().and_then(|r|scope(&r)).ok()}),
    )
}
#[tauri::command]
pub fn board_write_policy_set(
    enabled: bool,
    keep: usize,
    expected_revision: u64,
) -> Result<Policy, String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    if !(1..=100).contains(&keep) {
        return Err("备份份数须为1–100".into());
    }
    let dir = config::config_dir()?;
    let old = policy_at(&dir)?;
    if old.revision != expected_revision {
        return Err("授权设置已变化，请重新打开设置".into());
    }
    let next = Policy {
        enabled,
        keep,
        revision: old.revision.checked_add(1).ok_or("授权版本已满")?,
    };
    sync::atomic_bytes(
        &dir.join("board-write-policy.json"),
        &serde_json::to_vec(&next).map_err(err)?,
    )?;
    Ok(next)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    CreateNode {
        reference: String,
        title: String,
        #[serde(default)]
        summary: String,
        #[serde(default)]
        markdown: String,
        #[serde(default, rename = "parentId")]
        parent_id: Option<String>,
    },
    AppendDocument {
        #[serde(rename = "nodeId")]
        node_id: String,
        title: String,
        markdown: String,
    },
    ConnectNodes {
        from: String,
        to: String,
        #[serde(default)]
        label: String,
    },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub schema: String,
    pub operations: Vec<Operation>,
}
#[derive(Serialize, Deserialize)]
struct Backup {
    schema: String,
    project: String,
    board: String,
    created_at: String,
    reason: String,
    #[serde(default)]
    missing: Vec<String>,
    #[serde(default)]
    invalid: Vec<String>,
    #[serde(with="backup_bytes")]
    files: BTreeMap<String, Vec<u8>>,
}
// Keep old byte-array backups readable; binary originals use bounded base64 in v2
// rather than expanding every PDF/image byte into a JSON decimal number.
mod backup_bytes {
    use super::*;
    use base64::Engine;
    #[derive(Serialize,Deserialize)]
    #[serde(untagged)]
    enum Bytes{Legacy(Vec<u8>),Binary(String)}
    pub fn serialize<S:serde::Serializer>(files:&BTreeMap<String,Vec<u8>>,serializer:S)->Result<S::Ok,S::Error>{
        let encoded=files.iter().map(|(path,bytes)|{let value=if path.starts_with("docs/asset_"){Bytes::Binary(base64::engine::general_purpose::STANDARD.encode(bytes))}else{Bytes::Legacy(bytes.clone())};(path,value)}).collect::<BTreeMap<_,_>>();encoded.serialize(serializer)
    }
    pub fn deserialize<'de,D:serde::Deserializer<'de>>(deserializer:D)->Result<BTreeMap<String,Vec<u8>>,D::Error>{
        let encoded=BTreeMap::<String,Bytes>::deserialize(deserializer)?;let mut total=0usize;let mut files=BTreeMap::new();
        for(path,value)in encoded{let bytes=match value{Bytes::Legacy(bytes)=>bytes,Bytes::Binary(text)=>{if text.len()>90*1024*1024{return Err(serde::de::Error::custom("备份附件超出预算"));}base64::engine::general_purpose::STANDARD.decode(text).map_err(serde::de::Error::custom)?}};total=total.checked_add(bytes.len()).ok_or_else(||serde::de::Error::custom("备份过大"))?;if total>66*1024*1024{return Err(serde::de::Error::custom("备份超出恢复预算"));}files.insert(path,bytes);}Ok(files)
    }
}
#[derive(Serialize, Deserialize)]
pub struct BackupMeta {
    file: String,
    created_at: String,
    reason: String,
    bytes: u64,
}
pub(crate) fn checked_path(root: &Path, relative: &str) -> Result<std::path::PathBuf, String> {
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("非法备份路径".into());
        }
        path.push(component);
        if let Ok(meta) = fs::symlink_metadata(&path) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("资料路径不能包含重解析点".into());
                }
            }
            if meta.file_type().is_symlink() {
                return Err("资料路径不能包含符号链接".into());
            }
        }
    }
    Ok(path)
}
fn doc_key(path: &str) -> Result<String, String> {
    let name = path.strip_prefix("docs/").unwrap_or(path);
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':']) {
        return Err("非法文档备份路径".into());
    }
    Ok(format!("docs/{name}"))
}
pub(crate) fn backup_at(root: &Path, p: &str, b: &str, reason: &str) -> Result<(String, Vec<u8>), String> {
    let base = format!("{p}/{b}");
    let board_path = checked_path(root, &format!("{base}/board.json"))?;
    let board = storage::load_board(root, p, b)?;
    let mut files = BTreeMap::new();
    let mut missing = vec![];
    let mut invalid = vec![];
    files.insert("board.json".into(), fs::read(board_path).map_err(err)?);
    let mut total = files.get("board.json").map(Vec::len).unwrap_or(0);
    for doc in board.nodes.iter().flat_map(|n| &n.docs) {
        let key = doc_key(&doc.path)?;
        if files.contains_key(&key) || missing.contains(&key) {
            continue;
        }
        let path = checked_path(root, &format!("{base}/{key}"))?;
        if !path.exists() && reason == "恢复前保险" {
            missing.push(key);
            continue;
        }
        let len = fs::metadata(&path).map_err(err)?.len() as usize;
        total = total.checked_add(len).ok_or("备份过大")?;
        if total > 64 * 1024 * 1024 {
            return Err("关联文档超过64MiB，请先手动整理备份；本次未修改".into());
        }
        let body=fs::read(path).map_err(err)?;
        for asset in crate::documents::dependencies(&body)? {
            if files.contains_key(&asset.path){continue;}
            if reason=="恢复前保险"&&!checked_path(root,&format!("{base}/{}",asset.path))?.exists(){missing.push(asset.path);continue;}
            let bytes=match crate::documents::verified_asset(root,p,b,&asset){Ok(bytes)=>bytes,Err(error)=>{if reason!="恢复前保险"{return Err(error);}let path=checked_path(root,&format!("{base}/{}",asset.path))?;if fs::metadata(&path).map_err(err)?.len()>32*1024*1024{return Err("损坏附件超过保险预算，请先另行保留原件".into());}invalid.push(asset.path.clone());fs::read(path).map_err(err)?}};
            total=total.checked_add(bytes.len()).ok_or("备份过大")?;
            if total>64*1024*1024{return Err("关联附件超过64MiB，未修改白板".into());}
            files.insert(asset.path,bytes);
        }
        files.insert(key, body);
    }
    let name = format!("{}.json", storage::new_id("version"));
    let backup = Backup {
        schema: if files.keys().any(|p|p.starts_with("docs/asset_")){"lumen.board-backup/v2"}else{"lumen.board-backup/v1"}.into(),
        project: p.into(),
        board: b.into(),
        created_at: storage::now_iso(),
        reason: reason.into(),
        missing,
        invalid,
        files,
    };
    let encoded=serde_json::to_vec(&backup).map_err(err)?;
    if encoded.len()>128*1024*1024{return Err("备份超过128MiB，未修改白板；请先导出完整资料包".into());}
    Ok((name, encoded))
}
fn backup_files(root: &Path, p: &str, b: &str) -> Result<Vec<String>, String> {
    storage::safe_id(p)?;
    storage::safe_id(b)?;
    let dir = checked_path(root, &format!("{p}/{b}/.ai-backups"))?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    if fs::symlink_metadata(&dir)
        .map_err(err)?
        .file_type()
        .is_symlink()
    {
        return Err("备份目录不能是符号链接".into());
    }
    let mut files = fs::read_dir(dir)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with("version_") && n.ends_with(".json") {
                Some(n)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    files.sort();
    files.reverse();
    Ok(files)
}
pub(crate) fn prune(root: &Path, p: &str, b: &str, keep: usize) -> Result<(), String> {
    for file in backup_files(root, p, b)?.into_iter().skip(keep) {
        fs::remove_file(
            storage::board_dir(root, p, b)
                .join(".ai-backups")
                .join(file),
        )
        .map_err(err)?
    }
    Ok(())
}
fn text(value: &str, max: usize, required: bool) -> Result<(), String> {
    if value.len() > max || (required && value.trim().is_empty()) {
        Err("操作的标题或正文为空/超出长度限制".into())
    } else {
        Ok(())
    }
}
fn apply_at(
    root: &Path,
    p: &str,
    b: &str,
    revision: &str,
    request: &str,
    batch: Batch,
    keep: usize,
) -> Result<Value, String> {
    apply_full_at(root, p, b, revision, request, batch, keep, None)
}
fn digest(batch: &Batch) -> Result<String, String> {
    Ok(ring::digest::digest(
        &ring::digest::SHA256,
        &serde_json::to_vec(batch).map_err(err)?,
    )
    .as_ref()
    .iter()
    .map(|n| format!("{n:02x}"))
    .collect())
}
/// Merge one immutable conversation, preserving other windows and already saved messages.
pub(crate) fn normalize_chats(chats:&mut Value)->Result<(),String>{
    if chats["version"]!=1 {return Err("原始对话版本无效，原文件未改动".into());}
    let conversations=chats["conversations"].as_array_mut().ok_or("原始对话结构无效")?;
    let mut ids=std::collections::BTreeSet::new();
    let mut mids=std::collections::BTreeSet::new();
    for c in conversations {
        let id=c["id"].as_str().filter(|s|!s.is_empty()).ok_or("原始对话缺少标识")?.to_owned();
        if !ids.insert(id.clone()){return Err("原始对话标识重复".into());}
        let messages=c["messages"].as_array_mut().ok_or("原始对话消息无效")?;
        for (index,m) in messages.iter_mut().enumerate(){
            if m["content"].as_str().is_none()||!matches!(m["role"].as_str(),Some("user"|"assistant")){return Err("原始对话消息无效".into());}
            if m["id"].is_null(){m["id"]=json!(format!("{id}_m_{index}"));}
            let mid=m["id"].as_str().filter(|s|!s.is_empty()).ok_or("原始消息标识无效")?;
            if !mids.insert(mid.to_owned()){return Err("原始消息标识重复，原文件未改动".into());}
        }
    }
    Ok(())
}
pub(crate) fn merged_chat(root: &Path, p: &str, b: &str, mut conversation: Value) -> Result<Vec<u8>, String> {
    crate::chat_history::ensure_live(root,p,b,conversation["id"].as_str().ok_or("对话标识无效")?)?;
    let mut incoming_file=json!({"version":1,"conversations":[conversation]});
    normalize_chats(&mut incoming_file)?;
    conversation=incoming_file["conversations"][0].take();
    let id = conversation["id"].as_str().ok_or("对话缺少id")?;
    storage::safe_id(id)?;
    let incoming = conversation["messages"].as_array().ok_or("对话缺少消息")?;
    if incoming.iter().any(|m| {
        m["id"].as_str().is_none()
            || m["content"].as_str().is_none()
            || !matches!(m["role"].as_str(), Some("user" | "assistant"))
    }) {
        return Err("对话消息无效".into());
    }
    let raw = storage::read_chats(root, p, b)?;
    let mut chats: Value = if raw.trim().is_empty() {
        json!({"version":1,"conversations":[]})
    } else {
        serde_json::from_str(&raw).map_err(err)?
    };
    normalize_chats(&mut chats)?;
    let conversations = chats["conversations"]
        .as_array_mut()
        .ok_or("对话文件无效")?;
    if let Some(old) = conversations
        .iter_mut()
        .find(|c| c["id"].as_str() == Some(id))
    {
        if old["sourceNodeId"] != conversation["sourceNodeId"] {
            return Err("对话来源节点不一致".into());
        }
        let saved = old["messages"].as_array_mut().ok_or("对话消息无效")?;
        for message in incoming {
            if let Some(index) = saved.iter().position(|m| m["id"] == message["id"]) {
                let existing = &saved[index];
                if existing["role"] == "assistant"
                    && message["role"] == "assistant"
                    && message["content"]
                        .as_str()
                        .unwrap()
                        .starts_with(existing["content"].as_str().unwrap_or(""))
                {
                    saved[index] = message.clone();
                }
            } else {
                saved.push(message.clone());
            }
        }
        if conversation["updatedAt"].as_str() > old["updatedAt"].as_str() {
            old["updatedAt"] = conversation["updatedAt"].clone();
            old["title"] = conversation["title"].clone();
        }
    } else {
        conversations.push(conversation)
    }
    normalize_chats(&mut chats)?;
    let bytes = serde_json::to_vec_pretty(&chats).map_err(err)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("对话文件超过16MiB，本次未写入".into());
    }
    Ok(bytes)
}
#[tauri::command]
pub fn chat_conversation_upsert(
    window:tauri::WebviewWindow,
    project_id: String,
    board_id: String,
    conversation: Value,
    expected_scope: String,
    generation_token:Option<String>,
) -> Result<(), String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    storage::safe_id(&project_id)?;
    storage::safe_id(&board_id)?;
    let root = commands::root()?;
    let id=conversation["id"].as_str().ok_or("对话缺少id")?.to_owned();
    crate::chat_generation::validate_at(&root,&project_id,&board_id,&id,&expected_scope,window.label(),generation_token.as_deref())?;
    let bytes = scoped_conversation_bytes(&root, &project_id, &board_id, conversation, &expected_scope)?;
    sync::transaction(
        &root,
        BTreeMap::from([(format!("{project_id}/{board_id}/chats.json"), bytes)]),
    )?;
    crate::chat_generation::saved_at(&root,&project_id,&board_id,&id,&expected_scope)
}
fn scoped_conversation_bytes(root:&Path,p:&str,b:&str,conversation:Value,expected:&str)->Result<Vec<u8>,String>{
    ensure_scope(root,expected)?;
    storage::load_board(root,p,b)?;
    merged_chat(root,p,b,conversation)
}
fn apply_full_at(
    root: &Path,
    p: &str,
    b: &str,
    revision: &str,
    request: &str,
    batch: Batch,
    keep: usize,
    conversation: Option<Value>,
) -> Result<Value, String> {
    if let Some(c)=conversation.as_ref(){crate::chat_history::ensure_live(root,p,b,c["id"].as_str().ok_or("对话标识无效")?)?;}
    storage::safe_id(p)?;
    storage::safe_id(b)?;
    storage::safe_id(request)?;
    sync::recover(root)?;
    checked_path(root, &format!("{p}/{b}/board.json"))?;
    if batch.schema != "lumen.board-operations/v1"
        || batch.operations.is_empty()
        || batch.operations.len() > 28
    {
        return Err("操作协议或数量无效".into());
    }
    let base = format!("{p}/{b}");
    let receipt_path = format!("{base}/.ai-operations/{request}.json");
    let receipt_file = checked_path(root, &receipt_path)?;
    if receipt_file.exists() {
        let old: Value =
            serde_json::from_slice(&fs::read(receipt_file).map_err(err)?).map_err(err)?;
        if old["digest"].as_str() != Some(digest(&batch)?.as_str()) {
            return Err("重复操作标识包含不同内容".into());
        }
        let current = storage::load_board(root, p, b)?;
        let produced = old["documents"].as_array().ok_or("回执缺少文档")?;
        let node_ids = old["nodes"].as_object().ok_or("回执缺少节点")?;
        let edge_ids = old["edges"].as_array().ok_or("回执缺少连线")?;
        if edge_ids.iter().any(|id| {
            !current
                .edges
                .iter()
                .any(|edge| Some(edge.id.as_str()) == id.as_str())
        }) {
            return Err("这批操作此前已执行，当前已被恢复或移除；未自动重放".into());
        }
        if node_ids.values().any(|id| {
            !current
                .nodes
                .iter()
                .any(|n| Some(n.id.as_str()) == id.as_str())
        }) || produced.iter().any(|path| {
            !current
                .nodes
                .iter()
                .flat_map(|n| &n.docs)
                .any(|d| Some(d.path.as_str()) == path.as_str())
        }) {
            return Err("这批操作此前已执行，当前已被恢复或移除；未自动重放".into());
        }
        return Ok(
            json!({"board":current,"summary":old["summary"],"backup":old["backup"],"reused":true,"nodes":old["nodes"],"documents":old["documents"]}),
        );
    }
    if sync::board_revision(root, p, b)? != revision {
        return Err("白板已被修改，本批未写入，请重新发送".into());
    }
    let mut board = storage::load_board(root, p, b)?;
    let previous_edges = board
        .edges
        .iter()
        .map(|e| e.id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    let now = storage::now_iso();
    let mut nodes = 0usize;
    let mut docs = 0usize;
    let mut edges = 0usize;
    let mut total = 0usize;
    let mut refs = BTreeMap::<String, String>::new();
    let mut files = BTreeMap::new();
    let resolve = |value: &str, refs: &BTreeMap<String, String>| -> Result<String, String> {
        let id = refs.get(value).map(String::as_str).unwrap_or(value);
        storage::safe_id(id)?;
        Ok(id.into())
    };
    for operation in &batch.operations {
        match operation {
            Operation::CreateNode {
                reference,
                title,
                summary,
                markdown,
                parent_id,
            } => {
                nodes += 1;
                text(title, 600, true)?;
                text(summary, 8000, false)?;
                storage::safe_id(reference)?;
                if refs.contains_key(reference) || board.nodes.iter().any(|n| n.id == *reference) {
                    return Err("局部引用重复或与现有节点冲突".into());
                }
                let parent = parent_id.as_ref().map(|v| resolve(v, &refs)).transpose()?;
                if let Some(id) = &parent {
                    if !board.nodes.iter().any(|n| n.id == *id) {
                        return Err("父节点不存在".into());
                    }
                }
                let id = storage::new_id("n_ai");
                let (x, y) = parent
                    .as_ref()
                    .and_then(|v| board.nodes.iter().find(|n| &n.id == v))
                    .map(|n| (n.x + n.w + 80.0, n.y + (nodes - 1) as f64 * 180.0))
                    .unwrap_or((80.0, 80.0 + board.nodes.len() as f64 * 180.0));
                board.nodes.push(storage::BoardNode {
                    id: id.clone(),
                    title: title.trim().into(),
                    summary: Some(summary.clone()),
                    x,
                    y,
                    w: 240.0,
                    color: None,
                    docs: vec![],
                    created_at: now.clone(),
                    updated_at: now.clone(),
                });
                refs.insert(reference.clone(), id.clone());
                if !markdown.trim().is_empty() {
                    append(
                        &mut board, &id, title, markdown, &base, &mut files, &mut docs, &mut total,
                    )?;
                }
                if let Some(from) = parent {
                    edges += 1;
                    board.edges.push(storage::BoardEdge {
                        id: storage::new_id("e_ai"),
                        from,
                        to: id,
                        directed: true,
                        label: None,
                        created_at: now.clone(),
                    });
                }
            }
            Operation::AppendDocument {
                node_id,
                title,
                markdown,
            } => {
                let id = resolve(node_id, &refs)?;
                append(
                    &mut board, &id, title, markdown, &base, &mut files, &mut docs, &mut total,
                )?;
            }
            Operation::ConnectNodes { from, to, label } => {
                let from = resolve(from, &refs)?;
                let to = resolve(to, &refs)?;
                text(label, 600, false)?;
                if from == to
                    || ![&from, &to]
                        .iter()
                        .all(|id| board.nodes.iter().any(|n| &n.id == *id))
                {
                    return Err("连线端点无效".into());
                }
                if !board.edges.iter().any(|e| e.from == from && e.to == to) {
                    edges += 1;
                    board.edges.push(storage::BoardEdge {
                        id: storage::new_id("e_ai"),
                        from,
                        to,
                        directed: true,
                        label: Some(label.clone()),
                        created_at: now.clone(),
                    });
                }
            }
        }
        if nodes > 8 || edges > 12 || docs > 8 || total > 512 * 1024 {
            return Err("每批最多8节点、12连线、8篇文档、512KiB正文".into());
        }
    }
    let (backup, bytes) = backup_at(root, p, b, "修改前")?;
    files.insert(format!("{base}/.ai-backups/{backup}"), bytes);
    board.updated_at = now;
    files.insert(
        format!("{base}/board.json"),
        serde_json::to_vec_pretty(&board).map_err(err)?,
    );
    let documents = files
        .keys()
        .filter_map(|path| {
            path.strip_prefix(&format!("{base}/docs/"))
                .map(|name| format!("docs/{name}"))
        })
        .collect::<Vec<_>>();
    let summary = format!("已创建 {nodes} 个节点，追加 {docs} 篇文档、{edges} 条连线。");
    let created_edges = board
        .edges
        .iter()
        .filter(|e| !previous_edges.contains(&e.id))
        .map(|e| e.id.clone())
        .collect::<Vec<_>>();
    let receipt = json!({"digest":digest(&batch)?,"summary":summary,"backup":backup,"nodes":refs,"edges":created_edges,"documents":documents});
    files.insert(receipt_path, serde_json::to_vec(&receipt).map_err(err)?);
    if let Some(conversation) = conversation {
        files.insert(
            format!("{base}/chats.json"),
            merged_chat(root, p, b, conversation)?,
        );
    }
    sync::transaction(root, files)?;
    let warning = prune(root, p, b, keep).err();
    Ok(
        json!({"board":board,"summary":summary,"backup":backup,"nodes":refs,"documents":documents,"warning":warning,"reused":false}),
    )
}
fn append(
    board: &mut storage::BoardFile,
    id: &str,
    title: &str,
    markdown: &str,
    base: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
    docs: &mut usize,
    total: &mut usize,
) -> Result<(), String> {
    text(title, 600, true)?;
    text(markdown, 128 * 1024, true)?;
    let node = board
        .nodes
        .iter_mut()
        .find(|n| n.id == id)
        .ok_or("目标节点不存在")?;
    let path = format!("docs/{}.md", storage::new_id("note_ai"));
    files.insert(format!("{base}/{path}"), markdown.as_bytes().to_vec());
    node.docs.push(storage::DocRef {
        path,
        title: title.trim().into(),
        bytes: Some(markdown.len() as u64),
    });
    node.updated_at = storage::now_iso();
    *docs += 1;
    *total += markdown.len();
    Ok(())
}
#[tauri::command]
pub fn board_operations_apply(
    project_id: String,
    board_id: String,
    expected_revision: String,
    expected_scope: String,
    grant_revision: u64,
    request_id: String,
    batch: Batch,
) -> Result<Value, String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    let root = commands::root()?;
    let policy = policy_at(&config::config_dir()?)?;
    authorize(&root, &policy, &expected_scope, grant_revision)?;
    apply_at(
        &root,
        &project_id,
        &board_id,
        &expected_revision,
        &request_id,
        batch,
        policy.keep,
    )
}
fn authorize(
    root: &Path,
    policy: &Policy,
    expected_scope: &str,
    revision: u64,
) -> Result<(), String> {
    if !policy.enabled || policy.revision != revision {
        return Err("AI修改白板授权已关闭或变化，本批未写入".into());
    }
    if scope(root)? != expected_scope {
        return Err("保存目录已切换，本批未写入".into());
    }
    Ok(())
}
#[tauri::command]
pub fn chat_document_attach(
    project_id: String,
    board_id: String,
    expected_revision: String,
    expected_scope: String,
    request_id: String,
    node_id: String,
    title: String,
    markdown: String,
    conversation: Value,
) -> Result<Value, String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    let root = commands::root()?;
    if scope(&root)? != expected_scope {
        return Err("保存目录已切换".into());
    }
    let policy = policy_at(&config::config_dir()?)?;
    apply_full_at(
        &root,
        &project_id,
        &board_id,
        &expected_revision,
        &request_id,
        Batch {
            schema: "lumen.board-operations/v1".into(),
            operations: vec![Operation::AppendDocument {
                node_id,
                title,
                markdown,
            }],
        },
        policy.keep,
        Some(conversation),
    )
}
#[tauri::command]
pub fn board_backups_list(project_id: String, board_id: String) -> Result<Vec<BackupMeta>, String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    list_at(&commands::root()?, &project_id, &board_id)
}
fn list_at(root: &Path, p: &str, b: &str) -> Result<Vec<BackupMeta>, String> {
    let mut out = vec![];
    for file in backup_files(root, p, b)? {
        let path = checked_path(root, &format!("{p}/{b}/.ai-backups/{file}"))?;
        // Metadata precedes the large file bodies in both backup versions.
        // Read only its bounded prefix rather than re-reading every PDF/image.
        use std::io::Read;
        let mut raw=Vec::new();fs::File::open(&path).map_err(err)?.take(64*1024).read_to_end(&mut raw).map_err(err)?;
        if let Some(index)=raw.windows(8).position(|s|s==b"\"files\":") {raw.truncate(index);raw.extend_from_slice(b"\"files\":{}}");}
        #[derive(Deserialize)]
        struct Header {
            created_at: String,
            reason: String,
        }
        let meta=match serde_json::from_slice::<Header>(&raw){Ok(meta)=>meta,Err(_)=>{
            // Some v1 writers serialize a sorted JSON map with files before reason.
            // Stream those legacy records instead of hiding a valid backup.
            if fs::metadata(&path).map_err(err)?.len()>128*1024*1024{continue;}
            let Ok(meta)=serde_json::from_reader::<_,Header>(fs::File::open(&path).map_err(err)?) else{continue;};meta
        }};
        out.push(BackupMeta {
            file,
            created_at: meta.created_at,
            reason: meta.reason,
            bytes: fs::metadata(&path).map_err(err)?.len(),
        });
    }
    Ok(out)
}
pub(crate) fn restore_at(
    root: &Path,
    p: &str,
    b: &str,
    file: &str,
    revision: &str,
    keep: usize,
) -> Result<storage::BoardFile, String> {
    storage::safe_id(p)?;
    storage::safe_id(b)?;
    if !backup_files(root, p, b)?.iter().any(|n| n == file) {
        return Err("备份不存在".into());
    }
    if sync::board_revision(root, p, b)? != revision {
        return Err("白板已变化，请重新打开历史".into());
    }
    let path = checked_path(root, &format!("{p}/{b}/.ai-backups/{file}"))?;
    if fs::metadata(&path).map_err(err)?.len()>128*1024*1024{return Err("备份超过恢复预算，原件未改动".into());}
    let saved: Backup = serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
    if !matches!(saved.schema.as_str(),"lumen.board-backup/v1"|"lumen.board-backup/v2") || saved.project != p || saved.board != b {
        return Err("备份归属不符".into());
    }
    let board: storage::BoardFile =
        serde_json::from_slice(saved.files.get("board.json").ok_or("备份缺少白板")?)
            .map_err(err)?;
    if board.id != b || board.project_id != p {
        return Err("备份白板归属不符".into());
    }
    let mut allowed = board
        .nodes
        .iter()
        .flat_map(|n| &n.docs)
        .map(|d| doc_key(&d.path))
        .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
    for key in allowed.clone() {
        if let Some(body)=saved.files.get(&key) {
            for asset in crate::documents::dependencies(body)? {
                allowed.insert(asset.path.clone());
                if saved.missing.contains(&asset.path){continue;}
                let bytes=saved.files.get(&asset.path).ok_or("备份缺少附件原件")?;
                if !saved.invalid.contains(&asset.path)&&(bytes.len()!=asset.size||crate::documents::hash(bytes)!=asset.sha256){return Err("备份附件校验失败".into());}
                allowed.insert(asset.path);
            }
        }
    }
    for key in &allowed {
        if !saved.files.contains_key(key) && !saved.missing.contains(key) {
            return Err("备份缺少关联文档".into());
        }
    }
    if saved
        .missing
        .iter()
        .any(|key| !allowed.contains(key) || saved.files.contains_key(key))
    {
        return Err("备份缺失记录无效".into());
    }
    if saved.invalid.iter().any(|key|!allowed.contains(key)||!key.starts_with("docs/asset_")||!saved.files.contains_key(key)||saved.missing.contains(key)){return Err("备份损坏记录无效".into());}
    let base = format!("{p}/{b}");
    let mut files = BTreeMap::new();
    for (relative, bytes) in saved.files {
        if relative != "board.json"
            && (!allowed.contains(&relative) || doc_key(&relative)? != relative)
        {
            return Err("备份包含非文档文件".into());
        }
        checked_path(root, &format!("{base}/{relative}"))?;
        files.insert(format!("{base}/{relative}"), bytes);
    }
    let (insurance, bytes) = backup_at(root, p, b, "恢复前保险")?;
    files.insert(format!("{base}/.ai-backups/{insurance}"), bytes);
    sync::transaction(root, files)?;
    let _ = prune(root, p, b, keep);
    Ok(board)
}
#[tauri::command]
pub fn board_backup_restore(
    project_id: String,
    board_id: String,
    file: String,
    expected_revision: String,
    expected_scope: String,
) -> Result<storage::BoardFile, String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    let root = commands::root()?;
    if scope(&root)? != expected_scope {
        return Err("资料库已切换，请重新打开历史".into());
    }
    let keep = policy_at(&config::config_dir()?)?.keep;
    restore_at(
        &root,
        &project_id,
        &board_id,
        &file,
        &expected_revision,
        keep,
    )
}

#[tauri::command]
pub fn doc_export_markdown(
    project_id: String,
    board_id: String,
    path: String,
    destination: String,
) -> Result<(), String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    let root = commands::root()?;
    export_markdown_at(&root, &project_id, &board_id, &path, &destination)
}

fn export_markdown_at(root: &Path, project_id: &str, board_id: &str, path: &str, destination: &str) -> Result<(), String> {
    let source = storage::resolve_doc_path(&root, &project_id, &board_id, &path)?;
    if !source.extension().and_then(|s|s.to_str()).is_some_and(|s|s.eq_ignore_ascii_case("md")||s.eq_ignore_ascii_case("markdown")) {
        return Err("只能导出Markdown文档".into());
    }
    let target = export_destination(root,destination)?;
    sync::atomic_bytes(&target, &fs::read(source).map_err(err)?)
}
fn export_destination(root:&Path,destination:&str)->Result<std::path::PathBuf,String>{
    let target = std::path::PathBuf::from(destination);
    if !target.is_absolute() || !target.extension().and_then(|s|s.to_str()).is_some_and(|s|s.eq_ignore_ascii_case("md")) {
        return Err("请选择绝对路径的.md文件".into());
    }
    external_destination(root,destination)
}
pub(crate) fn external_destination(root:&Path,destination:&str)->Result<std::path::PathBuf,String>{
    let target=std::path::PathBuf::from(destination);
    if !target.is_absolute(){return Err("请选择绝对路径的导出文件".into());}
    let parent=target.parent().ok_or("导出目录无效")?.canonicalize().map_err(err)?;
    let root=root.canonicalize().map_err(err)?;
    if parent.starts_with(&root)||target.canonicalize().is_ok_and(|p|p.starts_with(&root)){return Err("请选择资料目录以外的位置导出，以保护原始文档。".into());}
    Ok(parent.join(target.file_name().ok_or("导出文件名无效")?))
}
#[tauri::command]
pub fn chat_transcript_export(markdown:String,destination:String)->Result<(),String>{
    let _g=sync::IO_LOCK.lock().map_err(err)?;
    export_transcript_at(&commands::root()?,&markdown,&destination)
}
fn export_transcript_at(root:&Path,markdown:&str,destination:&str)->Result<(),String>{
    if markdown.trim().is_empty()||markdown.len()>32*1024*1024{return Err("导出对话为空或超过32MiB".into());}
    sync::atomic_bytes(&export_destination(root,destination)?,markdown.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn backup_history_reads_bounded_metadata_and_legacy_arrays_still_decode(){
        let(root,p,b)=setup();let dir=storage::board_dir(&root,&p,&b).join(".ai-backups");fs::create_dir_all(&dir).unwrap();
        let body=format!("{{\"created_at\":\"2026-10-26T00:00:00Z\",\"reason\":\"图文资料\",\"files\":{{\"large\":\"{}\"}}}}","A".repeat(2*1024*1024));fs::write(dir.join("version_metadata.json"),&body).unwrap();
        let listed=list_at(&root,&p,&b).unwrap();assert_eq!(listed.len(),1);assert_eq!(listed[0].reason,"图文资料");assert_eq!(listed[0].bytes,body.len() as u64);
        let sorted_v1=json!({"schema":"lumen.board-backup/v1","project":p,"board":b,"created_at":"2026-10-26T00:00:00Z","reason":"对话导入前","files":{"board.json":[123,125]}});fs::write(dir.join("version_sorted.json"),serde_json::to_vec(&sorted_v1).unwrap()).unwrap();assert_eq!(list_at(&root,&p,&b).unwrap().len(),2);
        let original=json!({"schema":"lumen.board-backup/v1","project":p,"board":b,"created_at":"2026-10-26T00:00:00Z","reason":"legacy","files":{"docs/old.md":[65,66,67]}});let legacy:Backup=serde_json::from_value(original).unwrap();assert_eq!(legacy.files["docs/old.md"],b"ABC");fs::remove_dir_all(root).unwrap();
    }
    #[test]fn legacy_chat_merge_normalizes_once_and_rejects_colliding_ids(){
        let (root,p,b)=setup();let path=storage::board_dir(&root,&p,&b).join("chats.json");
        fs::write(&path,r#"{"version":1,"conversations":[{"id":"c","messages":[{"role":"user","content":"原问题"},{"role":"assistant","content":"原回答"}]}]}"#).unwrap();
        let incoming=json!({"id":"c","messages":[{"id":"c_m_0","role":"user","content":"原问题"},{"id":"c_m_1","role":"assistant","content":"原回答"},{"id":"new","role":"user","content":"新问题"}]});
        let bytes=merged_chat(&root,&p,&b,incoming.clone()).unwrap();fs::write(&path,&bytes).unwrap();let value:Value=serde_json::from_slice(&bytes).unwrap();assert_eq!(value["conversations"][0]["messages"].as_array().unwrap().len(),3);assert_eq!(merged_chat(&root,&p,&b,incoming).unwrap(),bytes);
        assert!(merged_chat(&root,&p,&b,json!({"id":"another","messages":[{"id":"new","role":"user","content":"collision"}]})).is_err());assert_eq!(fs::read(&path).unwrap(),bytes);
        let bad=r#"{"version":1,"conversations":[{"id":"c","messages":[{"role":"user","content":"原问题"},{"id":"c_m_0","role":"assistant","content":"原回答"}]}]}"#;fs::write(&path,bad).unwrap();assert!(merged_chat(&root,&p,&b,json!({"id":"new","messages":[]})).is_err());assert_eq!(fs::read_to_string(&path).unwrap(),bad);fs::remove_dir_all(root).unwrap();
    }
    #[test]fn recovery_export_protects_managed_and_reserved_targets(){
        let (root,p,b)=setup();let source=storage::docs_dir(&root,&p,&b).join("original.md");fs::write(&source,"original").unwrap();
        assert!(export_transcript_at(&root,"# recovery",source.to_str().unwrap()).is_err());assert_eq!(fs::read(&source).unwrap(),b"original");
        assert!(external_destination(&root,root.join("knowledge/library.json").to_str().unwrap()).is_err());
        let outside=std::env::temp_dir().join(storage::new_id("recovery_export"));fs::create_dir_all(&outside).unwrap();let target=outside.join("recovery.md");export_transcript_at(&root,"# 原始\n\n$x_i$\n\n```\nsource\n```",target.to_str().unwrap()).unwrap();assert!(fs::read_to_string(&target).unwrap().contains("$x_i$"));
        fs::remove_dir_all(outside).unwrap();fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn markdown_export_preserves_original_bytes_and_leaves_source_intact() {
        let (root, project, board) = setup();
        let original = "\u{feff}# 导出原文\r\n\r\n行内 $x_i^2$ 与中文。\r\n\r\n$$\\frac{1}{2}$$\r\n".as_bytes();
        let source = storage::docs_dir(&root, &project, &board).join("original.md");
        fs::write(&source, original).unwrap();
        let external = std::env::temp_dir().join(storage::new_id("export_target"));fs::create_dir_all(&external).unwrap();
        let target = external.join("exported.md");
        export_markdown_at(&root, &project, &board, "docs/original.md", target.to_str().unwrap()).unwrap();
        assert_eq!(fs::read(&target).unwrap(), original);
        assert_eq!(fs::read(&source).unwrap(), original);
        assert!(export_markdown_at(&root, &project, &board, "../board.json", target.to_str().unwrap()).is_err());
        assert!(export_markdown_at(&root, &project, &board, "docs/original.md", "relative.md").is_err());
        assert!(export_markdown_at(&root, &project, &board, "docs/original.md", source.to_str().unwrap()).is_err());
        let upper=source.with_file_name("Upper.MARKDOWN");fs::write(&upper,original).unwrap();export_markdown_at(&root,&project,&board,"docs/Upper.MARKDOWN",external.join("UPPER.MD").to_str().unwrap()).unwrap();
        #[cfg(unix)]{let link=external.join("alias");std::os::unix::fs::symlink(source.parent().unwrap(),&link).unwrap();assert!(export_transcript_at(&root,"overwrite",link.join("new.md").to_str().unwrap()).is_err());assert!(!source.parent().unwrap().join("new.md").exists());}
        fs::remove_dir_all(external).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn edge_only_receipt_is_not_replayed_after_restore() {
        let (r, p, b) = setup();
        apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "nodes",
            batch(),
            20,
        )
        .unwrap();
        let board = storage::load_board(&r, &p, &b).unwrap();
        let edges = || Batch {
            schema: "lumen.board-operations/v1".into(),
            operations: vec![Operation::ConnectNodes {
                from: board.nodes[1].id.clone(),
                to: board.nodes[0].id.clone(),
                label: String::new(),
            }],
        };
        let result = apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "edge",
            edges(),
            20,
        )
        .unwrap();
        restore_at(
            &r,
            &p,
            &b,
            result["backup"].as_str().unwrap(),
            &sync::board_revision(&r, &p, &b).unwrap(),
            20,
        )
        .unwrap();
        assert!(apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "edge",
            edges(),
            20
        )
        .unwrap_err()
        .contains("未自动重放"));
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn failure_after_backup_and_board_write_rolls_back_every_artifact() {
        let (r, p, b) = setup();
        let before = fs::read(storage::board_file(&r, &p, &b)).unwrap();
        let docs = storage::docs_dir(&r, &p, &b);
        fs::remove_dir(&docs).unwrap();
        fs::write(&docs, "合成磁盘故障").unwrap();
        assert!(apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "request",
            batch(),
            20
        )
        .is_err());
        assert_eq!(fs::read(storage::board_file(&r, &p, &b)).unwrap(), before);
        assert!(list_at(&r, &p, &b).unwrap().is_empty());
        assert!(!r.join(".lumen-sync/pending.json").exists());
        assert!(!storage::board_dir(&r, &p, &b)
            .join(".ai-operations/request.json")
            .exists());
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn independent_node_windows_merge_without_losing_other_conversations() {
        let (r, p, b) = setup();
        let make = |id: &str, node: &str, body: &str| json!({"id":id,"sourceNodeId":node,"title":body,"createdAt":"2026","updatedAt":"2026","messages":[{"id":format!("{id}_a"),"role":"assistant","content":body,"at":"2026"}]});
        let a = make("a", "node_a", "原文");
        let bytes = merged_chat(&r, &p, &b, a.clone()).unwrap();
        storage::write_chats(&r, &p, &b, &String::from_utf8(bytes).unwrap()).unwrap();
        let bytes = merged_chat(&r, &p, &b, make("b", "node_b", "其他会话")).unwrap();
        storage::write_chats(&r, &p, &b, &String::from_utf8(bytes).unwrap()).unwrap();
        let bytes = merged_chat(&r, &p, &b, make("a", "node_a", "原文，追加操作回执")).unwrap();
        storage::write_chats(&r, &p, &b, &String::from_utf8(bytes).unwrap()).unwrap();
        let restored: Value = serde_json::from_slice(&merged_chat(&r, &p, &b, a).unwrap()).unwrap();
        assert_eq!(restored["conversations"].as_array().unwrap().len(), 2);
        assert_eq!(
            restored["conversations"][0]["messages"][0]["content"],
            "原文，追加操作回执"
        );
        assert!(merged_chat(&r, &p, &b, make("a", "node_b", "串属")).is_err());
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn restore_recovers_deleted_documents_and_rejects_foreign_metadata() {
        let (r, p, b) = setup();
        apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "one",
            batch(),
            20,
        )
        .unwrap();
        let board = storage::load_board(&r, &p, &b).unwrap();
        let path = storage::resolve_doc_path(&r, &p, &b, &board.nodes[0].docs[0].path).unwrap();
        let original = fs::read(&path).unwrap();
        let (file, bytes) = backup_at(&r, &p, &b, "合成备份").unwrap();
        let directory = storage::board_dir(&r, &p, &b).join(".ai-backups");
        fs::write(directory.join(&file), &bytes).unwrap();
        fs::remove_file(&path).unwrap();
        restore_at(
            &r,
            &p,
            &b,
            &file,
            &sync::board_revision(&r, &p, &b).unwrap(),
            20,
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        let mut malformed: Value = serde_json::from_slice(&bytes).unwrap();
        malformed["files"]["chats.json"] = json!([123, 125]);
        fs::write(
            directory.join(&file),
            serde_json::to_vec(&malformed).unwrap(),
        )
        .unwrap();
        assert!(restore_at(
            &r,
            &p,
            &b,
            &file,
            &sync::board_revision(&r, &p, &b).unwrap(),
            20
        )
        .is_err());
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn limits_unknown_fields_and_reverted_receipts_are_rejected() {
        let (r, p, b) = setup();
        assert!(serde_json::from_value::<Batch>(json!({"schema":"lumen.board-operations/v1","operations":[{"type":"create_node","reference":"new","title":"t","path":"../private"}]})).is_err());
        let mut too_many = batch();
        for n in 0..9 {
            too_many.operations.push(Operation::CreateNode {
                reference: format!("extra_{n}"),
                title: "t".into(),
                summary: String::new(),
                markdown: String::new(),
                parent_id: None,
            });
        }
        assert!(apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "limit",
            too_many,
            20
        )
        .is_err());
        let result = apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "request",
            batch(),
            20,
        )
        .unwrap();
        restore_at(
            &r,
            &p,
            &b,
            result["backup"].as_str().unwrap(),
            &sync::board_revision(&r, &p, &b).unwrap(),
            20,
        )
        .unwrap();
        assert!(apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "request",
            batch(),
            20
        )
        .unwrap_err()
        .contains("未自动重放"));
        fs::remove_dir_all(r).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn linked_documents_cannot_be_copied_into_a_backup() {
        use std::os::unix::fs::symlink;
        let (r, p, b) = setup();
        apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "request",
            batch(),
            20,
        )
        .unwrap();
        let board = storage::load_board(&r, &p, &b).unwrap();
        let path = storage::resolve_doc_path(&r, &p, &b, &board.nodes[0].docs[0].path).unwrap();
        fs::remove_file(&path).unwrap();
        let outside = r.join("synthetic-outside.txt");
        fs::write(&outside, "不应被读取").unwrap();
        symlink(&outside, &path).unwrap();
        assert!(backup_at(&r, &p, &b, "修改前")
            .unwrap_err()
            .contains("符号链接"));
        fs::remove_dir_all(r).unwrap();
    }
    fn setup() -> (std::path::PathBuf, String, String) {
        let root = std::env::temp_dir().join(storage::new_id("lumen_ops_test"));
        storage::ensure_storage(&root).unwrap();
        let p = storage::create_project(&root, "合成项目").unwrap();
        let b = storage::create_board(&root, &p.id, "合成白板").unwrap();
        (root, p.id, b.id)
    }
    fn batch() -> Batch {
        serde_json::from_value(json!({"schema":"lumen.board-operations/v1","operations":[{"type":"create_node","reference":"first","title":"问题","markdown":"# 原文\n\n$x_i^2$"},{"type":"create_node","reference":"second","title":"下一层","parentId":"first","markdown":"回答"}]})).unwrap()
    }
    #[test]
    fn background_chat_rejects_foreign_root_and_empty_original_without_changes() {
        let (r,p,b)=setup();
        let (other,_,_)=setup();
        let conversation=json!({"id":"synthetic_chat","messages":[{"id":"m1","role":"user","content":"完整原问题"}]});
        let path=storage::chats_file(&r,&p,&b);
        assert!(scoped_conversation_bytes(&r,&p,&b,conversation.clone(),&scope(&other).unwrap()).unwrap_err().contains("资料目录已变化"));
        assert!(!path.exists());
        let bytes=scoped_conversation_bytes(&r,&p,&b,conversation.clone(),&scope(&r).unwrap()).unwrap();
        assert!(String::from_utf8(bytes).unwrap().contains("完整原问题"));
        fs::write(&path,b"  \n").unwrap();
        assert!(scoped_conversation_bytes(&r,&p,&b,conversation,&scope(&r).unwrap()).unwrap_err().contains("原始对话文件为空"));
        assert_eq!(fs::read(&path).unwrap(),b"  \n");
        fs::remove_dir_all(r).unwrap();fs::remove_dir_all(other).unwrap();
    }
    #[test]
    fn create_append_idempotency_and_exact_restore() {
        let (r, p, b) = setup();
        let before = fs::read(storage::board_file(&r, &p, &b)).unwrap();
        let rev = sync::board_revision(&r, &p, &b).unwrap();
        let result = apply_at(&r, &p, &b, &rev, "request_1", batch(), 2).unwrap();
        assert_eq!(result["board"]["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(result["board"]["edges"].as_array().unwrap().len(), 1);
        assert!(
            apply_at(&r, &p, &b, &rev, "request_1", batch(), 2).unwrap()["reused"]
                .as_bool()
                .unwrap()
        );
        let board = storage::load_board(&r, &p, &b).unwrap();
        let old_path = board.nodes[0].docs[0].path.clone();
        let raw = storage::read_doc(&r, &p, &b, &old_path).unwrap();
        let append = Batch {
            schema: "lumen.board-operations/v1".into(),
            operations: vec![Operation::AppendDocument {
                node_id: board.nodes[0].id.clone(),
                title: "新笔记".into(),
                markdown: "追加".into(),
            }],
        };
        apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "request_2",
            append,
            2,
        )
        .unwrap();
        assert_eq!(storage::read_doc(&r, &p, &b, &old_path).unwrap(), raw);
        let file = result["backup"].as_str().unwrap();
        restore_at(
            &r,
            &p,
            &b,
            file,
            &sync::board_revision(&r, &p, &b).unwrap(),
            2,
        )
        .unwrap();
        assert_eq!(fs::read(storage::board_file(&r, &p, &b)).unwrap(), before);
        assert!(storage::resolve_doc_path(&r, &p, &b, &old_path)
            .unwrap()
            .exists());
        assert_eq!(list_at(&r, &p, &b).unwrap().len(), 2);
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn permission_scope_and_stale_revision_reject_without_changes() {
        let (r, p, b) = setup();
        let policy = Policy {
            enabled: true,
            revision: 4,
            keep: 20,
        };
        assert!(authorize(&r, &Policy::default(), &scope(&r).unwrap(), 0).is_err());
        assert!(authorize(&r, &policy, &scope(&r).unwrap(), 3).is_err());
        assert!(authorize(&r, &policy, "other-library", 4).is_err());
        let before = fs::read(storage::board_file(&r, &p, &b)).unwrap();
        assert!(apply_at(&r, &p, &b, "stale", "request", batch(), 20).is_err());
        assert_eq!(fs::read(storage::board_file(&r, &p, &b)).unwrap(), before);
        assert!(list_at(&r, &p, &b).unwrap().is_empty());
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn invalid_batch_and_backup_failure_leave_no_partial_documents() {
        let (r, p, b) = setup();
        let rev = sync::board_revision(&r, &p, &b).unwrap();
        let mut invalid = batch();
        invalid.operations.push(Operation::ConnectNodes {
            from: "missing".into(),
            to: "first".into(),
            label: String::new(),
        });
        assert!(apply_at(&r, &p, &b, &rev, "bad_batch", invalid, 20).is_err());
        let dir = storage::board_dir(&r, &p, &b).join(".ai-backups");
        fs::write(&dir, "blocked").unwrap();
        assert!(apply_at(&r, &p, &b, &rev, "disk_failure", batch(), 20).is_err());
        assert!(storage::load_board(&r, &p, &b).unwrap().nodes.is_empty());
        assert!(storage::list_docs(&r, &p, &b).unwrap().is_empty());
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn restore_replays_original_document_bytes() {
        let (r, p, b) = setup();
        let result = apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "first",
            batch(),
            20,
        )
        .unwrap();
        let board = storage::load_board(&r, &p, &b).unwrap();
        let doc = board.nodes[0].docs[0].path.clone();
        let original = storage::read_doc(&r, &p, &b, &doc).unwrap();
        let saved = apply_at(
            &r,
            &p,
            &b,
            &sync::board_revision(&r, &p, &b).unwrap(),
            "second",
            batch(),
            20,
        )
        .unwrap();
        fs::write(
            storage::resolve_doc_path(&r, &p, &b, &doc).unwrap(),
            "外部修改",
        )
        .unwrap();
        restore_at(
            &r,
            &p,
            &b,
            saved["backup"].as_str().unwrap(),
            &sync::board_revision(&r, &p, &b).unwrap(),
            20,
        )
        .unwrap();
        assert_eq!(storage::read_doc(&r, &p, &b, &doc).unwrap(), original);
        assert!(result["backup"].is_string());
        fs::remove_dir_all(r).unwrap();
    }
}
