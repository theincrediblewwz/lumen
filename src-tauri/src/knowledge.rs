//! Independent knowledge is outside every board directory. No delete command.
use crate::{commands, storage, sync};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn empty() -> Value { json!({"version":1,"entries":[],"revisions":[],"bindings":[],"settings":[]}) }
pub(crate) fn validate(value: &Value, previous: &Value) -> Result<(), String> {
    if value["version"] != 1 { return Err("知识库版本不受支持".into()); }
    for table in ["entries","revisions","bindings","settings"] {
        let rows=value[table].as_array().ok_or("知识列表缺失")?;
        if rows.len()>100_000 { return Err("知识库超过数量限制".into()); }
        let mut ids=BTreeSet::new();
        for row in rows {
            let id=row["id"].as_str().ok_or("知识标识缺失")?;
            storage::safe_id(id)?;
            if !ids.insert(id) { return Err("知识标识重复".into()); }
        }
    }
    let entries=value["entries"].as_array().unwrap();
    let revisions=value["revisions"].as_array().unwrap();
    for table in ["entries","revisions"] {
        for row in value[table].as_array().unwrap() {
            if !["understanding","experience","material"].contains(&row["kind"].as_str().unwrap_or("")) || !["user","ai_adopted","source"].contains(&row["authorship"].as_str().unwrap_or("")) { return Err("知识类型无效".into()); }
            for (field,max,required) in [("title",200,true),("body",100_000,true),("source",6_000,false),("created_at",80,true)] {
                let text=row[field].as_str().ok_or("知识正文格式无效")?;
                if text.chars().count()>max || (required&&text.trim().is_empty()) { return Err("知识正文为空或超过限制".into()); }
            }
            let basis:Vec<String>=serde_json::from_str(row["basis_json"].as_str().ok_or("依据格式无效")?).map_err(|_|"依据格式无效")?;
            let owner=if table=="entries" { &row["id"] } else { &row["entry_id"] };
            if basis.len()>100 || basis.iter().any(|key| owner.as_str()==Some(key) || !entries.iter().any(|e|e["id"].as_str()==Some(key))) { return Err("知识依据不存在或引用自身".into()); }
            for field in if table=="entries" { vec!["created_at","updated_at"] } else { vec!["created_at"] } {
                chrono::DateTime::parse_from_rfc3339(row[field].as_str().ok_or("知识时间无效")?).map_err(|_|"知识时间无效")?;
            }
        }
    }
    for row in entries {
        if row["archived"]!=0 && row["archived"]!=1 { return Err("知识归档状态无效".into()); }
        let revision=revisions.iter().find(|r|r["id"]==row["revision_id"]&&r["entry_id"]==row["id"]).ok_or("知识版本缺失")?;
        for field in ["kind","title","body","source","authorship","basis_json"] { if revision[field]!=row[field] { return Err("知识正文与版本不一致".into()); } }
    }
    if revisions.iter().any(|row| !entries.iter().any(|e|e["id"]==row["entry_id"])) { return Err("知识版本归属无效".into()); }
    for table in ["entries","revisions"] {
        for old in previous[table].as_array().into_iter().flatten() {
            let new=value[table].as_array().unwrap().iter().find(|r|r["id"]==old["id"]).ok_or("请归档知识，不能移除其正文或历史")?;
            if table=="revisions" && new!=old { return Err("历史知识版本不能覆盖".into()); }
        }
    }
    for row in value["bindings"].as_array().unwrap() {
        storage::safe_id(row["project_id"].as_str().ok_or("白板标识缺失")?)?;
        if !entries.iter().any(|e|e["id"]==row["entry_id"]) { return Err("引用知识不存在".into()); }
        if !row["node_id"].is_null() { storage::safe_id(row["node_id"].as_str().ok_or("节点标识无效")?)?; }
        chrono::DateTime::parse_from_rfc3339(row["created_at"].as_str().ok_or("引用时间无效")?).map_err(|_|"引用时间无效")?;
    }
    let mut settings=BTreeSet::new();
    for row in value["settings"].as_array().unwrap() {
        let id=row["project_id"].as_str().ok_or("白板标识缺失")?;
        storage::safe_id(id)?;
        if row["id"].as_str()!=Some(id) || !settings.insert(id) || !["disabled","allowed","priority"].contains(&row["policy"].as_str().unwrap_or("")) { return Err("知识引用权限无效或重复".into()); }
        chrono::DateTime::parse_from_rfc3339(row["updated_at"].as_str().ok_or("权限时间无效")?).map_err(|_|"权限时间无效")?;
    }
    Ok(())
}
fn boards(files:&BTreeMap<String,Vec<u8>>) -> BTreeMap<String,BTreeSet<String>> {
    files.iter().filter(|(path,_)|path.ends_with("/board.json")).filter_map(|(_,bytes)| {
        let board:Value=serde_json::from_slice(bytes).ok()?;
        Some((board["id"].as_str()?.to_string(),board["nodes"].as_array()?.iter().filter_map(|n|n["id"].as_str().map(String::from)).collect()))
    }).collect()
}
pub(crate) fn validate_ownership(value:&Value, files:&BTreeMap<String,Vec<u8>>) -> Result<(),String> {
    let boards=boards(files);
    for table in ["bindings","settings"] { for row in value[table].as_array().ok_or("知识关联缺失")? {
        let nodes=boards.get(row["project_id"].as_str().ok_or("白板标识无效")?).ok_or("知识引用白板不存在")?;
        if table=="bindings" && !row["node_id"].is_null() && !nodes.contains(row["node_id"].as_str().ok_or("节点标识无效")?) { return Err("知识引用节点不属于白板".into()); }
    }}
    Ok(())
}
#[tauri::command]
pub fn knowledge_load() -> Result<Value, String> {
    let snapshot=sync::sync_snapshot()?;
    let mut library=match snapshot.files.get("knowledge/library.json") { Some(bytes)=>serde_json::from_slice(bytes).map_err(|e|e.to_string())?,None=>empty() };
    validate(&library,&empty())?;
    // Removing a board only removes its bindings; all entries and history stay independent.
    let boards=boards(&snapshot.files);
    for table in ["bindings","settings"] { library[table].as_array_mut().unwrap().retain(|row|boards.get(row["project_id"].as_str().unwrap_or("")).is_some_and(|nodes| table=="settings" || row["node_id"].is_null() || nodes.contains(row["node_id"].as_str().unwrap_or("")))); }
    Ok(json!({"revision":snapshot.revision,"library":library}))
}
#[tauri::command]
pub fn knowledge_save(expected_revision: String, library: Value) -> Result<String, String> {
    let _guard=sync::IO_LOCK.lock().map_err(|e|e.to_string())?;
    let root=commands::root()?;
    sync::recover(&root)?;
    let snapshot=sync::snapshot(&root)?;
    if snapshot.revision!=expected_revision { return Err("资料已经变化，草稿已保留，请重新打开后保存".into()); }
    let previous=match snapshot.files.get("knowledge/library.json") { Some(bytes)=>serde_json::from_slice(bytes).map_err(|e|e.to_string())?,None=>empty() };
    validate(&library,&previous)?;
    validate_ownership(&library,&snapshot.files)?;
    let bytes=serde_json::to_vec_pretty(&library).map_err(|e|e.to_string())?;
    if bytes.len()>32*1024*1024 { return Err("知识库超过本次文件保存限制".into()); }
    sync::transaction(&root,BTreeMap::from([("knowledge/library.json".into(),bytes)]))?;
    Ok(sync::snapshot(&root)?.revision)
}
#[tauri::command]
pub fn knowledge_export(path:String) -> Result<(),String> {
    use std::io::Write;
    let snapshot=knowledge_load()?;
    let bytes=serde_json::to_vec_pretty(&json!({"format":"learnstuff-knowledge-library","version":1,"library":snapshot["library"]})).map_err(|e|e.to_string())?;
    if bytes.len()>32*1024*1024 { return Err("知识文件超过 32 MB 限制".into()); }
    let target=crate::board_operations::external_destination(&commands::root()?,&path)?;
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e|format!("不能覆盖已有文件，请选一个新文件名：{e}"))?;
    file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|e|e.to_string())
}
#[tauri::command]
pub fn knowledge_import_read(path:String) -> Result<Value,String> {
    use std::io::Read;
    let file=std::fs::File::open(&path).map_err(|e|e.to_string())?;
    let mut bytes=Vec::new(); file.take(32*1024*1024+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len()>32*1024*1024 { return Err("知识文件超过 32 MB 限制".into()); }
    let value:Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
    if value["format"]!="learnstuff-knowledge-library" || value["version"]!=1 { return Err("请选择本应用导出的知识库文件；HistoryandKnowledge 格式尚未接入".into()); }
    validate(&value["library"],&empty())?;
    Ok(value["library"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn library() -> Value {
        let now="2026-10-08T00:00:00Z";
        let revision=json!({"id":"revision","entry_id":"entry","kind":"understanding","title":"我的理解","body":"原始观点","source":"","authorship":"user","basis_json":"[]","created_at":now});
        let entry=json!({"id":"entry","revision_id":"revision","kind":"understanding","title":"我的理解","body":"原始观点","source":"","authorship":"user","basis_json":"[]","archived":0,"created_at":now,"updated_at":now});
        json!({"version":1,"entries":[entry],"revisions":[revision],"bindings":[],"settings":[]})
    }
    #[test] fn history_cannot_be_replaced_or_deleted() {
        let before=library();validate(&before,&empty()).unwrap();
        let mut next=before.clone();next["revisions"][0]["body"]=json!("被覆盖");next["entries"][0]["body"]=json!("被覆盖");
        assert!(validate(&next,&before).unwrap_err().contains("不能覆盖"));
        assert!(validate(&empty(),&before).unwrap_err().contains("不能移除"));
        let mut archived=before.clone();archived["entries"][0]["archived"]=json!(1);validate(&archived,&before).unwrap();
    }
    #[test] fn missing_material_version_and_foreign_board_are_rejected() {
        let mut value=library();value["entries"][0]["revision_id"]=json!("missing");assert!(validate(&value,&empty()).is_err());
        let mut value=library();value["bindings"]=json!([{"id":"binding","project_id":"board","node_id":"foreign-node","entry_id":"entry","created_at":"2026-10-08T00:00:00Z"}]);
        validate(&value,&empty()).unwrap();
        let files=BTreeMap::from([("project/board/board.json".into(),serde_json::to_vec(&json!({"id":"board","nodes":[{"id":"valid-node"}]})).unwrap())]);
        assert!(validate_ownership(&value,&files).unwrap_err().contains("不属于白板"));
    }
}
