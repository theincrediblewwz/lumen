//! Opt-in desktop synchronization. All writes use a recoverable before-image journal.
use crate::{commands, secrets, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, hash::{Hash, Hasher}, io::Write, path::{Component, Path, PathBuf}, sync::Mutex};

pub static IO_LOCK: Mutex<()> = Mutex::new(());
const LIMIT: usize = 64 * 1024 * 1024;
const META: &str = ".lumen-sync";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings { pub enabled: bool, pub endpoint: String, pub username: String, pub library_id: String, pub device_id: String }
#[derive(Serialize, Deserialize, Clone)]
pub struct Snapshot { pub revision: String, pub files: BTreeMap<String, Vec<u8>>, pub ledger: Option<Value> }
#[derive(Serialize, Deserialize)]
struct WriteEntry { path: String, before: Option<Vec<u8>>, after: Vec<u8> }
#[derive(Serialize, Deserialize)]
struct Journal { committed:bool, entries:Vec<WriteEntry> }

fn err(e: impl std::fmt::Display) -> String { e.to_string() }
pub fn board_revision(root: &Path, project: &str, board: &str) -> Result<String, String> {
    let path = storage::board_file(root, storage::safe_id(project)?, storage::safe_id(board)?);
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    fs::read(path).map_err(err)?.hash(&mut hash);
    Ok(format!("{:016x}", hash.finish()))
}
pub fn chats_revision(root:&Path,project:&str,board:&str)->Result<String,String>{
    let content=storage::read_chats(root,project,board)?;let mut hash=std::collections::hash_map::DefaultHasher::new();content.hash(&mut hash);Ok(format!("{:016x}",hash.finish()))
}
fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() || relative.contains('\\') || relative.contains(':') || relative.starts_with('/') { return Err("非法的同步路径".into()); }
    let rel = Path::new(relative);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) { return Err("非法的同步路径".into()); }
    let mut path = root.to_path_buf();
    for c in rel.components() {
        path.push(c);
        if fs::symlink_metadata(&path).map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("同步目录不能包含符号链接".into()); }
    }
    Ok(path)
}

/// ReplaceFile semantics on Windows, rename on Unix; never unlink the old file first.
pub fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("文件缺少父目录")?).map_err(err)?;
    let tmp = path.with_extension(format!("{}.tmp", storage::new_id("sync")));
    let mut file = fs::File::create(&tmp).map_err(err)?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(err)?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" { fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32; }
        let a: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 1 | 8) } == 0 { return Err(err(std::io::Error::last_os_error())); }
    }
    #[cfg(not(windows))]
    fs::rename(&tmp, path).map_err(err)?;
    #[cfg(unix)]
    fs::File::open(path.parent().unwrap()).and_then(|f| f.sync_all()).map_err(err)?;
    Ok(())
}

pub fn recover(root: &Path) -> Result<(), String> {
    let path = safe_path(root, &format!("{META}/pending.json"))?;
    if !path.exists() { return Ok(()); }
    let journal: Journal = serde_json::from_slice(&fs::read(&path).map_err(err)?).map_err(err)?;
    if journal.committed {return fs::remove_file(path).map_err(err);}
    for e in journal.entries.iter().rev() {
        let target = safe_path(root, &e.path)?;
        match &e.before { Some(bytes) => atomic_bytes(&target, bytes)?, None => { if target.exists() { fs::remove_file(target).map_err(err)?; } } }
    }
    fs::remove_file(path).map_err(err)
}

fn transaction(root: &Path, files: BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    recover(root)?;
    let mut entries = Vec::new();
    for (path, after) in files {
        let target = safe_path(root, &path)?;
        let before = if target.exists() { Some(fs::read(target).map_err(err)?) } else { None };
        if before.as_ref() != Some(&after) { entries.push(WriteEntry { path, before, after }); }
    }
    if entries.is_empty() { return Ok(()); }
    let journal = safe_path(root, &format!("{META}/pending.json"))?;
    let mut record=Journal{committed:false,entries};
    atomic_bytes(&journal, &serde_json::to_vec(&record).map_err(err)?)?;
    for e in &record.entries {
        if let Err(error) = atomic_bytes(&safe_path(root, &e.path)?, &e.after) {
            recover(root).map_err(|rollback| format!("写入失败，恢复日志保留：{error}; {rollback}"))?;
            return Err(error);
        }
    }
    // Durable commit marker prevents a resurrected directory entry after power loss rolling
    // back an acknowledged commit. A crash before the marker restores all before-images.
    record.committed=true;
    if let Err(error)=atomic_bytes(&journal,&serde_json::to_vec(&record).map_err(err)?){recover(root)?;return Err(error);}
    fs::remove_file(journal).map_err(err)
}

fn settings(root: &Path) -> Result<SyncSettings, String> {
    let path = safe_path(root, &format!("{META}/settings.json"))?;
    if !path.exists() { return Ok(SyncSettings::default()); }
    serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)
}
fn read_file(root: &Path, relative: &str, files: &mut BTreeMap<String, Vec<u8>>, total: &mut usize) -> Result<(), String> {
    let path = safe_path(root, relative)?;
    let size = fs::metadata(&path).map_err(err)?.len() as usize;
    *total = total.checked_add(size).ok_or("同步库过大")?;
    if *total > LIMIT { return Err("当前桌面适配最多处理 64 MiB 的单次同步库，请缩小库后重试".into()); }
    files.insert(relative.to_string(), fs::read(path).map_err(err)?);
    Ok(())
}
fn collect_dir(root: &Path, relative: &str, files: &mut BTreeMap<String, Vec<u8>>, total: &mut usize) -> Result<(), String> {
    let path = safe_path(root, relative)?;
    if !path.exists() { return Ok(()); }
    for item in fs::read_dir(path).map_err(err)? {
        let item = item.map_err(err)?;
        let name = item.file_name().into_string().map_err(|_| "文件名不是 UTF-8")?;
        let next = format!("{relative}/{name}");
        let typ = item.file_type().map_err(err)?;
        if typ.is_symlink() { return Err("同步目录不能包含符号链接".into()); }
        if typ.is_dir() { collect_dir(root, &next, files, total)?; } else if typ.is_file() { read_file(root, &next, files, total)?; }
    }
    Ok(())
}
fn snapshot(root: &Path) -> Result<Snapshot, String> {
    let mut files = BTreeMap::new(); let mut total = 0;
    if storage::index_path(root).exists() { read_file(root, "index.json", &mut files, &mut total)?; }
    for project in storage::read_index(root)?.projects {
        storage::safe_id(&project.id)?;
        read_file(root, &format!("{}/project.json", project.id), &mut files, &mut total)?;
        for board in storage::read_project(root, &project.id)?.boards {
            storage::safe_id(&board.id)?;
            let dir = format!("{}/{}", project.id, board.id);
            read_file(root, &format!("{dir}/board.json"), &mut files, &mut total)?;
            for name in ["chats.json", "chat-captures.json", "reading-positions.json"] {
                let path = format!("{dir}/{name}");
                if safe_path(root, &path)?.exists() { read_file(root, &path, &mut files, &mut total)?; }
            }
            collect_dir(root, &format!("{dir}/docs"), &mut files, &mut total)?;
        }
    }
    let ledger_path = safe_path(root, &format!("{META}/ledger.json"))?;
    let raw = if ledger_path.exists() { fs::read(ledger_path).map_err(err)? } else { vec![] };
    let ledger = if raw.is_empty() { None } else { Some(serde_json::from_slice(&raw).map_err(err)?) };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    files.hash(&mut hasher); raw.hash(&mut hasher);
    Ok(Snapshot { revision: format!("{:016x}", hasher.finish()), files, ledger })
}

#[tauri::command]
pub fn sync_settings_get() -> Result<SyncSettings, String> { let _g = IO_LOCK.lock().map_err(err)?; settings(&commands::root()?) }
#[tauri::command]
pub fn sync_settings_set(mut config: SyncSettings, password: Option<String>) -> Result<SyncSettings, String> {
    let _g = IO_LOCK.lock().map_err(err)?; let root = commands::root()?;
    let old = settings(&root)?;
    if config.enabled {
        let url = reqwest::Url::parse(&config.endpoint).map_err(|_| "WebDAV 地址无效")?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return Err("请使用不含密码、查询参数的 HTTPS WebDAV 地址".into()); }
        storage::safe_id(&config.library_id)?;
        if config.library_id.len() > 96 { return Err("同步库标识过长".into()); }
        if !old.library_id.is_empty() && old.library_id != config.library_id { return Err("现有库标识不能更改；请为新库选择独立的存储目录".into()); }
        config.endpoint = format!("{}/", config.endpoint.trim_end_matches('/'));
    }
    config.device_id = if old.device_id.is_empty() { storage::new_id("desktop") } else { old.device_id };
    if let Some(password) = password { if !password.is_empty() { secrets::set_secret(&format!("sync-{}", config.library_id), &password)?; } }
    atomic_bytes(&safe_path(&root, &format!("{META}/settings.json"))?, &serde_json::to_vec(&config).map_err(err)?)?;
    Ok(config)
}
#[tauri::command]
pub fn sync_snapshot() -> Result<Snapshot, String> { let _g = IO_LOCK.lock().map_err(err)?; snapshot(&commands::root()?) }
#[tauri::command]
pub fn reading_position_get(project_id:String,board_id:String,path:String) -> Result<Option<f64>,String> {
    let _g=IO_LOCK.lock().map_err(err)?;let root=commands::root()?;
    let file=safe_path(&root,&format!("{}/{}/reading-positions.json",storage::safe_id(&project_id)?,storage::safe_id(&board_id)?))?;
    if !file.exists(){return Ok(None);}
    let values:Vec<Value>=serde_json::from_slice(&fs::read(file).map_err(err)?).map_err(err)?;
    Ok(values.iter().find(|v|v["path"].as_str()==Some(&path)).and_then(|v|v["ratio"].as_f64()))
}
#[tauri::command]
pub fn reading_position_set(project_id:String,board_id:String,path:String,ratio:f64) -> Result<(),String> {
    let _g=IO_LOCK.lock().map_err(err)?;let root=commands::root()?;
    if !settings(&root)?.enabled {return Ok(());}
    if !ratio.is_finite() || !(0.0..=1.0).contains(&ratio){return Err("阅读进度无效".into());}
    storage::resolve_doc_path(&root,&project_id,&board_id,&path)?;
    let file=safe_path(&root,&format!("{}/{}/reading-positions.json",storage::safe_id(&project_id)?,storage::safe_id(&board_id)?))?;
    let mut values:Vec<Value>=if file.exists(){serde_json::from_slice(&fs::read(&file).map_err(err)?).map_err(err)?}else{vec![]};
    values.retain(|v|v["path"].as_str()!=Some(&path));values.push(json!({"path":path,"ratio":ratio,"anchor":null,"updated_at":storage::now_iso()}));
    atomic_bytes(&file,&serde_json::to_vec(&values).map_err(err)?)
}
#[tauri::command]
pub fn sync_apply(expected_revision: String, files: BTreeMap<String, Vec<u8>>, ledger: Value) -> Result<String, String> {
    let _g = IO_LOCK.lock().map_err(err)?; let root = commands::root()?;
    if !settings(&root)?.enabled { return Err("同步已暂停".into()); }
    if snapshot(&root)?.revision != expected_revision { return Err("本地内容已改变，保留更改并在下一轮重新同步".into()); }
    let mut writes = files;
    for path in writes.keys() {
        if path.starts_with('.') { return Err("同步不能写入保留路径".into()); }
        safe_path(&root, path)?;
    }
    writes.insert(format!("{META}/ledger.json"), serde_json::to_vec(&ledger).map_err(err)?);
    transaction(&root, writes)?;
    Ok(snapshot(&root)?.revision)
}

#[derive(Serialize)]
pub struct HttpResponse { status: u16, headers: BTreeMap<String, String>, body: Vec<u8> }
#[tauri::command]
pub async fn sync_http(url: String, method: String, headers: BTreeMap<String, String>, body: Vec<u8>) -> Result<HttpResponse, String> {
    let config = { let _g = IO_LOCK.lock().map_err(err)?; settings(&commands::root()?)? };
    if !config.enabled { return Err("同步已暂停".into()); }
    let base = reqwest::Url::parse(&config.endpoint).map_err(|_| "同步地址无效")?;
    let target = reqwest::Url::parse(&url).map_err(|_| "同步地址无效")?;
    if target.origin() != base.origin() || !target.path().starts_with(base.path()) || target.query().is_some() || target.fragment().is_some() || !target.username().is_empty() || target.password().is_some() { return Err("请求越过同步目录".into()); }
    if !["GET", "PUT", "PROPFIND", "MKCOL"].contains(&method.as_str()) || body.len() > LIMIT { return Err("不允许的同步请求".into()); }
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(30)).build().map_err(|_| "无法创建同步连接")?;
    let mut request = client.request(reqwest::Method::from_bytes(method.as_bytes()).map_err(err)?, target).body(body);
    for (k, v) in headers { if ["depth", "if-none-match", "content-type"].contains(&k.to_lowercase().as_str()) { request = request.header(k, v); } }
    if !config.username.is_empty() {
        let password = secrets::get_secret(&format!("sync-{}", config.library_id))?.ok_or("请保存 WebDAV 应用密码")?;
        request = request.basic_auth(config.username, Some(password));
    }
    let mut response = request.send().await.map_err(|_| "同步连接失败；请检查已有连接和 WebDAV 设置")?;
    let status = response.status().as_u16();
    let headers = response.headers().iter().filter_map(|(k,v)| v.to_str().ok().map(|v| (k.to_string(),v.to_string()))).collect();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取同步响应失败")? {
        if bytes.len() + chunk.len() > LIMIT { return Err("同步响应超过 64 MiB 限制".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(HttpResponse { status, headers, body: bytes })
}

#[tauri::command]
pub fn chat_capture(project_id: String, board_id: String, key: String, title: String, markdown: String, conversation_id: String, conversation: Value, message_ids: Vec<String>, parent_id: Option<String>) -> Result<storage::BoardFile, String> {
    let _g = IO_LOCK.lock().map_err(err)?; let root = commands::root()?;
    capture_at(&root,project_id,board_id,key,title,markdown,conversation_id,conversation,message_ids,parent_id)
}
fn capture_at(root: &Path, project_id: String, board_id: String, key: String, title: String, markdown: String, conversation_id: String, conversation: Value, message_ids: Vec<String>, parent_id: Option<String>) -> Result<storage::BoardFile, String> {
    if key.len() != 64 || !key.chars().all(|c| c.is_ascii_hexdigit()) || message_ids.is_empty() || markdown.trim().is_empty() || title.trim().is_empty() { return Err("保存内容无效".into()); }
    let mut board = storage::load_board(&root, &project_id, &board_id)?;
    let selection_key=format!("chat:{}:{}",conversation_id,message_ids.join(","));
    let base = format!("{project_id}/{board_id}");
    let captures_path = format!("{base}/chat-captures.json");
    let path = safe_path(&root, &captures_path)?;
    let mut captures: Vec<Value> = if path.exists() { serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)? } else { vec![] };
    if captures.iter().any(|c|c["selection_key"].as_str()==Some(&selection_key)&&board.nodes.iter().any(|n|Some(n.id.as_str())==c["node_id"].as_str())) {return Ok(board);}
    captures.retain(|c|c["selection_key"].as_str()!=Some(&selection_key));
    let node_id = format!("chat_{key}");
    if board.nodes.iter().any(|n| n.id == node_id) { return Ok(board); }
    let parent = parent_id.as_ref().and_then(|id| board.nodes.iter().find(|n| &n.id == id));
    if parent_id.is_some() && parent.is_none() { return Err("来源节点已不存在".into()); }
    let (x,y) = parent.map(|n| (n.x + n.w + 80.0, n.y + 80.0)).unwrap_or((80.0, 80.0 + board.nodes.len() as f64 * 40.0));
    let now = storage::now_iso(); let doc_path = format!("docs/chat_{key}.md");
    board.nodes.push(storage::BoardNode { id: node_id.clone(), title: title.trim().into(), summary: Some(format!("来自对话：{conversation_id}")), x,y,w:240.0,color:None, docs: vec![storage::DocRef { path:doc_path.clone(),title:title.trim().into(),bytes:Some(markdown.len() as u64) }],created_at:now.clone(),updated_at:now.clone() });
    if let Some(parent) = parent_id { board.edges.push(storage::BoardEdge { id:format!("capture_{key}"),from:parent,to:node_id.clone(),directed:true,label:Some("对话笔记".into()),created_at:now.clone() }); }
    board.updated_at = now.clone();
    captures.push(json!({"id":format!("capture_{key}"),"conversation_id":conversation_id,"source_answer_id":null,"document_path":doc_path,"node_id":node_id,"message_ids_json":serde_json::to_string(&message_ids).map_err(err)?,"selection_key":selection_key,"created_at":now}));
    let mut files = BTreeMap::new();
    if conversation["id"].as_str() != Some(&conversation_id) || !conversation["messages"].is_array() { return Err("原对话内容无效".into()); }
    let messages = conversation["messages"].as_array().unwrap();
    if message_ids.iter().any(|id| !messages.iter().any(|m| m["id"].as_str() == Some(id))) { return Err("所选消息不存在于原对话".into()); }
    let raw = storage::read_chats(&root, &project_id, &board_id)?;
    let mut chats: Value = if raw.trim().is_empty() { json!({"version":1,"conversations":[]}) } else { serde_json::from_str(&raw).map_err(err)? };
    let conversations = chats["conversations"].as_array_mut().ok_or("原对话文件结构无效")?;
    if let Some(existing) = conversations.iter_mut().find(|c| c["id"].as_str() == Some(&conversation_id)) {
        // A stale AI window must never replace newer messages already on disk.
        let saved=existing["messages"].as_array_mut().ok_or("原对话消息结构无效")?;
        for message in messages { if !saved.iter().any(|m|m["id"]==message["id"]){saved.push(message.clone());} }
        if conversation["updatedAt"].as_str()>existing["updatedAt"].as_str(){existing["updatedAt"]=conversation["updatedAt"].clone();}
    } else { conversations.push(conversation); }
    files.insert(format!("{base}/chats.json"),serde_json::to_vec_pretty(&chats).map_err(err)?);
    files.insert(format!("{base}/{doc_path}"), markdown.into_bytes());
    files.insert(format!("{base}/board.json"),serde_json::to_vec_pretty(&board).map_err(err)?);
    files.insert(captures_path,serde_json::to_vec(&captures).map_err(err)?);
    transaction(&root,files)?;
    Ok(board)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf { let p = std::env::temp_dir().join(storage::new_id("sync_test")); fs::create_dir_all(&p).unwrap(); p }
    #[test] fn interrupted_transaction_restores_before_images() {
        let root = temp(); let p = root.join("a.json"); atomic_bytes(&p,b"before").unwrap();
        let entries = vec![WriteEntry { path:"a.json".into(),before:Some(b"before".to_vec()),after:b"after".to_vec() },WriteEntry {path:"new.json".into(),before:None,after:b"new".to_vec()}];
        atomic_bytes(&root.join(META).join("pending.json"),&serde_json::to_vec(&Journal{committed:false,entries}).unwrap()).unwrap();
        atomic_bytes(&p,b"after").unwrap(); atomic_bytes(&root.join("new.json"),b"new").unwrap();
        recover(&root).unwrap(); assert_eq!(fs::read(p).unwrap(),b"before"); assert!(!root.join("new.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn traversal_is_rejected() { let root = temp(); for p in ["../x","/x","a/../x","C:/x","a\\x"] { assert!(safe_path(&root,p).is_err()); } fs::remove_dir_all(root).unwrap(); }
    #[test] fn durable_commit_marker_is_not_rolled_back_on_recovery(){
        let root=temp();atomic_bytes(&root.join("a.json"),b"after").unwrap();
        let journal=Journal{committed:true,entries:vec![WriteEntry{path:"a.json".into(),before:Some(b"before".to_vec()),after:b"after".to_vec()}]};
        atomic_bytes(&root.join(META).join("pending.json"),&serde_json::to_vec(&journal).unwrap()).unwrap();
        recover(&root).unwrap();assert_eq!(fs::read(root.join("a.json")).unwrap(),b"after");fs::remove_dir_all(root).unwrap();
    }
    #[test] fn transaction_commits_all_files() { let root = temp(); let mut files = BTreeMap::new(); files.insert("a.json".into(),b"one".to_vec()); files.insert("b.json".into(),b"two".to_vec()); transaction(&root,files).unwrap(); recover(&root).unwrap(); assert_eq!(fs::read(root.join("a.json")).unwrap(),b"one"); assert_eq!(fs::read(root.join("b.json")).unwrap(),b"two"); fs::remove_dir_all(root).unwrap(); }
    #[test] fn failure_after_first_write_rolls_back_every_file() {
        let root=temp();atomic_bytes(&root.join("a.json"),b"before").unwrap();atomic_bytes(&root.join("z-blocker"),b"file").unwrap();
        let mut files=BTreeMap::new();files.insert("a.json".into(),b"after".to_vec());files.insert("z-blocker/blocked.json".into(),b"cannot write".to_vec());
        assert!(transaction(&root,files).is_err());assert_eq!(fs::read(root.join("a.json")).unwrap(),b"before");assert!(!root.join(META).join("pending.json").exists());fs::remove_dir_all(root).unwrap();
    }
    #[test] fn capture_is_atomic_idempotent_and_preserves_chat() {
        let root=temp();let p=storage::create_project(&root,"Project").unwrap();let b=storage::create_board(&root,&p.id,"Board").unwrap();
        let conversation=json!({"id":"c1","title":"Original","createdAt":"2026-09-22","updatedAt":"2026-09-22","messages":[{"id":"m1","role":"assistant","content":"# Original\n\n回答","at":"2026-09-22"}]});
        let key="a".repeat(64);
        for _ in 0..2 { let board=capture_at(&root,p.id.clone(),b.id.clone(),key.clone(),"Note".into(),"# Original\n\n回答".into(),"c1".into(),conversation.clone(),vec!["m1".into()],None).unwrap();assert_eq!(board.nodes.len(),1);assert_eq!(board.nodes[0].docs.len(),1); }
        let chats:Value=serde_json::from_str(&storage::read_chats(&root,&p.id,&b.id).unwrap()).unwrap();assert_eq!(chats["conversations"][0],conversation);
        let captures:Vec<Value>=serde_json::from_slice(&fs::read(storage::board_dir(&root,&p.id,&b.id).join("chat-captures.json")).unwrap()).unwrap();assert_eq!(captures.len(),1);assert_eq!(captures[0]["message_ids_json"],"[\"m1\"]");
        assert_eq!(storage::read_doc(&root,&p.id,&b.id,&format!("docs/chat_{key}.md")).unwrap(),"# Original\n\n回答");fs::remove_dir_all(root).unwrap();
    }
    #[test] fn capture_reuses_android_selection_identity_and_keeps_newer_original() {
        let root=temp();let p=storage::create_project(&root,"Project").unwrap();let b=storage::create_board(&root,&p.id,"Board").unwrap();
        let newer=json!({"id":"c1","title":"Original","createdAt":"2026-09-22","updatedAt":"2026-09-22","messages":[{"id":"m1","role":"assistant","content":"newer","at":"2026-09-22"}]});
        storage::write_chats(&root,&p.id,&b.id,&json!({"version":1,"conversations":[newer.clone()]}).to_string()).unwrap();
        let mut older=newer.clone();older["messages"][0]["content"]=json!("older");
        let board=capture_at(&root,p.id.clone(),b.id.clone(),"b".repeat(64),"Note".into(),"older selected text".into(),"c1".into(),older.clone(),vec!["m1".into()],None).unwrap();
        let chats:Value=serde_json::from_str(&storage::read_chats(&root,&p.id,&b.id).unwrap()).unwrap();assert_eq!(chats["conversations"][0]["messages"][0]["content"],"newer");
        let other=capture_at(&root,p.id.clone(),b.id.clone(),"c".repeat(64),"Second press".into(),"older selected text".into(),"c1".into(),older,vec!["m1".into()],None).unwrap();
        assert_eq!(other.nodes.len(),1);assert_eq!(other.nodes[0].id,board.nodes[0].id);
        let captures:Value=serde_json::from_slice(&fs::read(storage::board_dir(&root,&p.id,&b.id).join("chat-captures.json")).unwrap()).unwrap();assert_eq!(captures[0]["selection_key"],"chat:c1:m1");fs::remove_dir_all(root).unwrap();
    }
}
