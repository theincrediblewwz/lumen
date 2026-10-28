//! Explicit conversation deletion with local recovery and stale-writer protection.
use crate::{board_operations, chat_generation, commands, storage, sync};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};
use tauri::Emitter;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn path(root: &Path, p: &str, b: &str, name: &str) -> Result<std::path::PathBuf, String> {
    storage::safe_id(p)?;
    storage::safe_id(b)?;
    board_operations::checked_path(root, &format!("{p}/{b}/{name}"))
}
fn read(root: &Path, p: &str, b: &str, name: &str, fallback: Value) -> Result<Value, String> {
    let target = path(root, p, b, name)?;
    if target.exists() {
        serde_json::from_slice(&fs::read(target).map_err(err)?).map_err(err)
    } else {
        Ok(fallback)
    }
}
fn markers(root: &Path, p: &str, b: &str) -> Result<Value, String> {
    let value = read(
        root,
        p,
        b,
        ".chat-deleted.json",
        json!({"version":1,"deleted":{}}),
    )?;
    if value["version"] != 1 || !value["deleted"].is_object() {
        return Err("删除记录损坏，原始资料未改动".into());
    }
    Ok(value)
}
fn chats(root: &Path, p: &str, b: &str) -> Result<Value, String> {
    let raw = storage::read_chats(root, p, b)?;
    let mut value = if raw.trim().is_empty() {
        json!({"version":1,"conversations":[]})
    } else {
        serde_json::from_str(&raw).map_err(err)?
    };
    board_operations::normalize_chats(&mut value)?;
    Ok(value)
}
pub(crate) fn ensure_live(root: &Path, p: &str, b: &str, c: &str) -> Result<(), String> {
    if markers(root, p, b)?["deleted"].get(c).is_some() {
        return Err("原对话已删除并归档；已保存的笔记仍可阅读，请先撤销删除或新建对话。".into());
    }
    Ok(())
}
pub(crate) fn ensure_content_live(root: &Path, p: &str, b: &str, raw: &str) -> Result<(), String> {
    let mut value: Value = serde_json::from_str(raw).map_err(err)?;
    board_operations::normalize_chats(&mut value)?;
    for c in value["conversations"].as_array().unwrap() {
        ensure_live(root, p, b, c["id"].as_str().unwrap())?;
    }
    Ok(())
}
fn insert(
    writes: &mut BTreeMap<String, Vec<u8>>,
    p: &str,
    b: &str,
    name: &str,
    value: &Value,
) -> Result<(), String> {
    writes.insert(
        format!("{p}/{b}/{name}"),
        serde_json::to_vec_pretty(value).map_err(err)?,
    );
    Ok(())
}
fn stage_archive(
    root: &Path,
    p: &str,
    b: &str,
    conversation: &Value,
    receipt: &str,
    deleted: &mut Value,
    captures: &mut Value,
    writes: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    storage::safe_id(receipt)?;
    let id = conversation["id"].as_str().ok_or("会话标识无效")?;
    chat_generation::ensure_idle(root, p, b, id)?;
    if path(root, p, b, &format!(".chat-trash/{receipt}.json"))?.exists() {
        return Err("删除回执冲突，原始资料未改动".into());
    }
    let rows = captures.as_array_mut().ok_or("捕获索引损坏")?;
    let related: Vec<Value> = rows
        .iter()
        .filter(|v| v["conversation_id"].as_str() == Some(id))
        .cloned()
        .collect();
    rows.retain(|v| v["conversation_id"].as_str() != Some(id));
    insert(
        writes,
        p,
        b,
        &format!(".chat-trash/{receipt}.json"),
        &json!({"version":1,"receipt":receipt,"conversation":conversation,"captures":related,"deletedAt":storage::now_iso(),"restored":false}),
    )?;
    deleted["deleted"][id] = json!(receipt);
    Ok(())
}
fn delete_at(
    root: &Path,
    p: &str,
    b: &str,
    c: &str,
    baseline: &str,
    receipt: &str,
) -> Result<Value, String> {
    storage::safe_id(c)?;
    storage::safe_id(receipt)?;
    sync::recover(root)?;
    storage::load_board(root, p, b)?;
    let mut deleted = markers(root, p, b)?;
    if deleted["deleted"][c].as_str() == Some(receipt) {
        return Ok(
            json!({"conversationId":c,"receipt":receipt,"scope":board_operations::scope(root)?}),
        );
    }
    ensure_live(root, p, b, c)?;
    if chat_generation::fingerprint_at(root, p, b, c)? != baseline {
        return Err("对话已变化，请刷新历史后再删除；原始资料未改动。".into());
    }
    let mut current = chats(root, p, b)?;
    let rows = current["conversations"].as_array_mut().unwrap();
    let index = rows
        .iter()
        .position(|v| v["id"].as_str() == Some(c))
        .ok_or("找不到待删除会话")?;
    let conversation = rows.remove(index);
    let mut captures = read(root, p, b, "chat-captures.json", json!([]))?;
    let mut writes = BTreeMap::new();
    stage_archive(
        root,
        p,
        b,
        &conversation,
        receipt,
        &mut deleted,
        &mut captures,
        &mut writes,
    )?;
    insert(&mut writes, p, b, "chats.json", &current)?;
    insert(&mut writes, p, b, "chat-captures.json", &captures)?;
    insert(&mut writes, p, b, ".chat-deleted.json", &deleted)?;
    sync::transaction(root, writes)?;
    Ok(
        json!({"conversationId":c,"receipt":receipt,"scope":board_operations::scope(root)?,"title":conversation["title"]}),
    )
}
fn restore_at(root: &Path, p: &str, b: &str, receipt: &str) -> Result<Value, String> {
    storage::safe_id(receipt)?;
    sync::recover(root)?;
    let board = storage::load_board(root, p, b)?;
    let mut archive = read(
        root,
        p,
        b,
        &format!(".chat-trash/{receipt}.json"),
        Value::Null,
    )?;
    if archive["version"] != 1 || archive["receipt"].as_str() != Some(receipt) {
        return Err("删除归档不存在或格式无效".into());
    }
    let c = archive["conversation"]["id"]
        .as_str()
        .ok_or("归档缺少会话标识")?
        .to_owned();
    chat_generation::ensure_idle(root, p, b, &c)?;
    let mut deleted = markers(root, p, b)?;
    if archive["restored"] == true && deleted["deleted"].get(&c).is_none() {
        return Ok(json!({"conversationId":c,"scope":board_operations::scope(root)?}));
    }
    if deleted["deleted"][&c].as_str() != Some(receipt) {
        return Err("删除记录已变化，未恢复或覆盖其他会话。".into());
    }
    let mut current = chats(root, p, b)?;
    let rows = current["conversations"].as_array_mut().unwrap();
    if rows.iter().any(|v| v["id"].as_str() == Some(&c)) {
        return Err("同标识会话已存在，未覆盖。".into());
    }
    rows.push(archive["conversation"].clone());
    board_operations::normalize_chats(&mut current)?;
    if serde_json::to_vec_pretty(&current).map_err(err)?.len() > 16 * 1024 * 1024 {
        return Err("恢复后历史超过16MiB，归档已保留。".into());
    }
    let mut captures = read(root, p, b, "chat-captures.json", json!([]))?;
    let rows = captures.as_array_mut().ok_or("捕获索引损坏")?;
    for capture in archive["captures"].as_array().ok_or("归档捕获索引损坏")? {
        if !board
            .nodes
            .iter()
            .any(|n| Some(n.id.as_str()) == capture["node_id"].as_str())
        {
            continue;
        }
        let doc = capture["document_path"]
            .as_str()
            .ok_or("归档文档路径无效")?;
        if !doc.starts_with("docs/") {
            return Err("归档文档路径无效".into());
        }
        if !board_operations::checked_path(root, &format!("{p}/{b}/{doc}"))?.is_file() {
            continue;
        }
        if rows.iter().any(|old| old["id"] == capture["id"]) {
            return Err("捕获来源标识冲突，归档已保留。".into());
        }
        rows.push(capture.clone());
    }
    deleted["deleted"].as_object_mut().unwrap().remove(&c);
    archive["restored"] = json!(true);
    let mut writes = BTreeMap::new();
    insert(&mut writes, p, b, "chats.json", &current)?;
    insert(&mut writes, p, b, "chat-captures.json", &captures)?;
    insert(&mut writes, p, b, ".chat-deleted.json", &deleted)?;
    insert(
        &mut writes,
        p,
        b,
        &format!(".chat-trash/{receipt}.json"),
        &archive,
    )?;
    sync::transaction(root, writes)?;
    Ok(json!({"conversationId":c,"scope":board_operations::scope(root)?}))
}
#[tauri::command]
pub fn chat_history_delete(
    app: tauri::AppHandle,
    project_id: String,
    board_id: String,
    conversation_id: String,
    expected_scope: String,
    baseline: String,
    receipt: String,
) -> Result<Value, String> {
    let result = {
        let _g = sync::IO_LOCK.lock().map_err(err)?;
        let root = commands::root()?;
        board_operations::ensure_scope(&root, &expected_scope)?;
        delete_at(
            &root,
            &project_id,
            &board_id,
            &conversation_id,
            &baseline,
            &receipt,
        )?
    };
    let _=app.emit("lumen://chat-history-changed",json!({"projectId":project_id,"boardId":board_id,"conversationId":conversation_id,"scope":expected_scope,"deleted":true}));
    Ok(result)
}
#[tauri::command]
pub fn chat_history_restore(
    app: tauri::AppHandle,
    project_id: String,
    board_id: String,
    expected_scope: String,
    receipt: String,
) -> Result<Value, String> {
    let result = {
        let _g = sync::IO_LOCK.lock().map_err(err)?;
        let root = commands::root()?;
        board_operations::ensure_scope(&root, &expected_scope)?;
        restore_at(&root, &project_id, &board_id, &receipt)?
    };
    let _=app.emit("lumen://chat-history-changed",json!({"projectId":project_id,"boardId":board_id,"conversationId":result["conversationId"],"scope":expected_scope,"deleted":false}));
    Ok(result)
}
/// Remote tombstones get the same local archive; an old remote version cannot
/// silently resurrect a locally deleted conversation.
pub(crate) fn prepare_sync(
    root: &Path,
    writes: &mut BTreeMap<String, Vec<u8>>,
    ledger: &Value,
) -> Result<Vec<(String, String, String, bool)>, String> {
    let previous_path = board_operations::checked_path(root, ".lumen-sync/ledger.json")?;
    let previous: Value = if previous_path.exists() {
        serde_json::from_slice(&fs::read(previous_path).map_err(err)?).map_err(err)?
    } else {
        Value::Null
    };
    let mut events = vec![];
    let projected: Vec<_> = writes
        .iter()
        .filter(|(path, _)| path.ends_with("/chats.json"))
        .map(|(path, bytes)| (path.clone(), bytes.clone()))
        .collect();
    for (name, bytes) in projected {
        let parts: Vec<_> = name.split('/').collect();
        if parts.len() != 3 {
            return Err("对话投影路径无效".into());
        }
        let (p, b) = (parts[0], parts[1]);
        let raw = String::from_utf8(bytes).map_err(err)?;
        let mut incoming: Value = serde_json::from_str(&raw).map_err(err)?;
        board_operations::normalize_chats(&mut incoming)?;
        let old = chats(root, p, b)?;
        let mut deleted = markers(root, p, b)?;
        let mut captures: Value =
            if let Some(bytes) = writes.get(&format!("{p}/{b}/chat-captures.json")) {
                serde_json::from_slice(bytes).map_err(err)?
            } else {
                read(root, p, b, "chat-captures.json", json!([]))?
            };
        let original_captures = read(root, p, b, "chat-captures.json", json!([]))?;
        let mut changed = false;
        for live in incoming["conversations"].as_array().unwrap() {
            let id = live["id"].as_str().unwrap();
            if let Some(receipt) = deleted["deleted"][id].as_str().map(str::to_owned) {
                // The sync core projects a new live revision only after resolving
                // the locally recorded tombstone. A stale pre-delete projection has
                // no such predecessor and is rejected instead of winning silently.
                let prior_deleted = previous["entities"].as_object().is_some_and(|rows| {
                    rows.values().any(|v| {
                        v["kind"] == "conversations"
                            && v["id"] == id
                            && v["boardId"] == b
                            && v.get("data") == Some(&Value::Null)
                    })
                });
                let next_live = ledger["entities"].as_object().is_some_and(|rows| {
                    rows.values().any(|v| {
                        v["kind"] == "conversations"
                            && v["id"] == id
                            && v["boardId"] == b
                            && v["data"].is_object()
                    })
                });
                if !prior_deleted || !next_live {
                    return Err(
                        "同步版本含已删除会话，请先处理删除冲突或撤销删除；双方资料均保留。".into(),
                    );
                }
                chat_generation::ensure_idle(root, p, b, id)?;
                let mut archive = read(
                    root,
                    p,
                    b,
                    &format!(".chat-trash/{receipt}.json"),
                    Value::Null,
                )?;
                if archive["receipt"] != receipt {
                    return Err("删除归档损坏，未接纳远端恢复。".into());
                }
                archive["restored"] = json!(true);
                insert(
                    writes,
                    p,
                    b,
                    &format!(".chat-trash/{receipt}.json"),
                    &archive,
                )?;
                deleted["deleted"].as_object_mut().unwrap().remove(id);
                changed = true;
                events.push((p.into(), b.into(), id.into(), false));
            }
        }
        for c in old["conversations"].as_array().unwrap() {
            let id = c["id"].as_str().unwrap();
            if incoming["conversations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["id"].as_str() == Some(id))
            {
                continue;
            }
            let tombstone = ledger["entities"].as_object().is_some_and(|rows| {
                rows.values().any(|v| {
                    v["kind"] == "conversations"
                        && v["id"] == id
                        && v["boardId"] == b
                        && v.get("data") == Some(&Value::Null)
                })
            });
            if !tombstone {
                return Err("对话投影意外缺失，未删除本地原文。".into());
            }
            let mut source = original_captures.clone();
            stage_archive(
                root,
                p,
                b,
                c,
                &storage::new_id("deleted"),
                &mut deleted,
                &mut source,
                writes,
            )?;
            captures
                .as_array_mut()
                .ok_or("投影捕获索引无效")?
                .retain(|v| v["conversation_id"] != id);
            changed = true;
            events.push((p.into(), b.into(), id.into(), true));
        }
        if changed {
            insert(writes, p, b, ".chat-deleted.json", &deleted)?;
            insert(writes, p, b, "chat-captures.json", &captures)?;
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, String, String) {
        let root = std::env::temp_dir().join(storage::new_id("chat_delete_test"));
        let p = storage::create_project(&root, "synthetic").unwrap();
        let meta = storage::create_board(&root, &p.id, "synthetic").unwrap();
        let mut board = storage::load_board(&root, &p.id, &meta.id).unwrap();
        board.nodes.push(storage::BoardNode {
            id: "saved".into(),
            title: "saved note".into(),
            summary: None,
            x: 1.,
            y: 2.,
            w: 240.,
            color: None,
            docs: vec![storage::DocRef {
                path: "docs/saved.md".into(),
                title: "note".into(),
                bytes: None,
            }],
            created_at: "at".into(),
            updated_at: "at".into(),
        });
        storage::save_board(&root, &board).unwrap();
        fs::write(
            storage::docs_dir(&root, &p.id, &board.id).join("saved.md"),
            "# user edited\n$x_i$",
        )
        .unwrap();
        let current = json!({"version":1,"conversations":[{"id":"c1","title":"one","messages":[{"id":"q1","role":"user","content":"question"},{"id":"a1","role":"assistant","content":"answer"}]},{"id":"c2","title":"two","extra":"preserve","messages":[{"id":"q2","role":"user","content":"other"}]}]});
        let base = storage::board_dir(&root, &p.id, &board.id);
        fs::write(
            base.join("chats.json"),
            serde_json::to_vec(&current).unwrap(),
        )
        .unwrap();
        fs::write(base.join("chat-captures.json"),serde_json::to_vec(&json!([{"id":"capture1","conversation_id":"c1","node_id":"saved","document_path":"docs/saved.md"}])).unwrap()).unwrap();
        (root, p.id, board.id)
    }
    #[test]
    fn delete_and_undo_preserve_copies_other_conversations_and_block_stale_writers() {
        let (root, p, b) = fixture();
        let original = chats(&root, &p, &b).unwrap();
        let base = storage::board_dir(&root, &p, &b);
        let note = fs::read(base.join("docs/saved.md")).unwrap();
        let board = fs::read(base.join("board.json")).unwrap();
        let digest = chat_generation::fingerprint_at(&root, &p, &b, "c1").unwrap();
        delete_at(&root, &p, &b, "c1", &digest, "delete1").unwrap();
        delete_at(&root, &p, &b, "c1", &digest, "delete1").unwrap();
        let current = chats(&root, &p, &b).unwrap();
        assert_eq!(current["conversations"][0], original["conversations"][1]);
        assert_eq!(current["conversations"].as_array().unwrap().len(), 1);
        assert!(read(&root, &p, &b, "chat-captures.json", Value::Null)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert!(
            board_operations::merged_chat(&root, &p, &b, original["conversations"][0].clone())
                .is_err()
        );
        assert!(ensure_content_live(&root, &p, &b, &original.to_string()).is_err());
        assert!(sync::snapshot(&root)
            .unwrap()
            .files
            .keys()
            .all(|p| !p.contains(".chat-trash") && !p.contains(".chat-deleted")));
        restore_at(&root, &p, &b, "delete1").unwrap();
        restore_at(&root, &p, &b, "delete1").unwrap();
        assert_eq!(
            chats(&root, &p, &b).unwrap()["conversations"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            read(&root, &p, &b, "chat-captures.json", Value::Null)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(fs::read(base.join("docs/saved.md")).unwrap(), note);
        assert_eq!(fs::read(base.join("board.json")).unwrap(), board);
        delete_at(&root, &p, &b, "c1", &digest, "delete2").unwrap();
        assert!(restore_at(&root, &p, &b, "delete1").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn archive_failure_rolls_back_original_bytes() {
        let (root, p, b) = fixture();
        let base = storage::board_dir(&root, &p, &b);
        let original = fs::read(base.join("chats.json")).unwrap();
        let captures = fs::read(base.join("chat-captures.json")).unwrap();
        fs::write(base.join(".chat-trash"), b"block directory").unwrap();
        let digest = chat_generation::fingerprint_at(&root, &p, &b, "c1").unwrap();
        assert!(delete_at(&root, &p, &b, "c1", &digest, "delete").is_err());
        assert_eq!(fs::read(base.join("chats.json")).unwrap(), original);
        assert_eq!(fs::read(base.join("chat-captures.json")).unwrap(), captures);
        assert!(!base.join(".chat-deleted.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn changed_or_running_conversation_cannot_be_deleted() {
        let (root, p, b) = fixture();
        assert!(delete_at(&root, &p, &b, "c1", "stale", "delete").is_err());
        {
            let _lease = chat_generation::test_lease(&root, &p, &b, "c1");
            let digest = chat_generation::fingerprint_at(&root, &p, &b, "c1").unwrap();
            assert!(delete_at(&root, &p, &b, "c1", &digest, "delete").is_err());
        }
        assert!(ensure_live(&root, &p, &b, "c1").is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn undo_restores_original_conversation_when_its_saved_document_was_later_removed() {
        let (root, p, b) = fixture();
        let digest = chat_generation::fingerprint_at(&root, &p, &b, "c1").unwrap();
        delete_at(&root, &p, &b, "c1", &digest, "delete").unwrap();
        fs::remove_file(storage::docs_dir(&root, &p, &b).join("saved.md")).unwrap();
        restore_at(&root, &p, &b, "delete").unwrap();
        assert!(ensure_live(&root, &p, &b, "c1").is_ok());
        assert!(read(&root, &p, &b, "chat-captures.json", Value::Null)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn sync_tombstone_archives_locally_and_a_subsequent_resolved_restore_can_sync_back() {
        let (root, p, b) = fixture();
        let original = chats(&root, &p, &b).unwrap();
        let mut incoming = original.clone();
        incoming["conversations"]
            .as_array_mut()
            .unwrap()
            .retain(|v| v["id"] != "c1");
        let tombstone = json!({"entities":{"conversations/c1":{"kind":"conversations","id":"c1","boardId":b,"data":null}}});
        let mut writes = BTreeMap::from([(
            format!("{p}/{b}/chats.json"),
            serde_json::to_vec(&incoming).unwrap(),
        )]);
        let events = prepare_sync(&root, &mut writes, &tombstone).unwrap();
        assert_eq!(events.len(), 1);
        sync::transaction(&root, writes).unwrap();
        assert!(ensure_live(&root, &p, &b, "c1").is_err());
        let live = json!({"entities":{"conversations/c1":{"kind":"conversations","id":"c1","boardId":b,"data":{"id":"c1"}}}});
        let make = || {
            BTreeMap::from([(
                format!("{p}/{b}/chats.json"),
                serde_json::to_vec(&original).unwrap(),
            )])
        };
        assert!(prepare_sync(&root, &mut make(), &live).is_err());
        sync::atomic_bytes(
            &root.join(".lumen-sync/ledger.json"),
            &serde_json::to_vec(&tombstone).unwrap(),
        )
        .unwrap();
        let mut writes = make();
        let events = prepare_sync(&root, &mut writes, &live).unwrap();
        assert_eq!(events[0].3, false);
        sync::transaction(&root, writes).unwrap();
        assert!(ensure_live(&root, &p, &b, "c1").is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
