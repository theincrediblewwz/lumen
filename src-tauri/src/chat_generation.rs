//! A generation belongs to one window until its final original transcript is saved.
use crate::{board_operations, commands, storage, sync};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::Manager;
#[derive(Clone)]
struct Lease {
    owner: String,
    token: String,
    baseline: String,
}
type Leases = BTreeMap<String, Lease>;
fn leases() -> &'static Mutex<Leases> {
    static ROWS: OnceLock<Mutex<Leases>> = OnceLock::new();
    ROWS.get_or_init(|| Mutex::new(BTreeMap::new()))
}
pub(crate) fn release_owner(owner: &str) {
    if let Ok(mut rows) = leases().lock() {
        rows.retain(|_, existing| existing.owner != owner);
    }
}
fn key(scope: &str, p: &str, b: &str, c: &str) -> String {
    json!([scope, p, b, c]).to_string()
}
pub(crate) fn fingerprint_at(root: &Path, p: &str, b: &str, c: &str) -> Result<String, String> {
    storage::load_board(root, p, b)?;
    let raw = storage::read_chats(root, p, b)?;
    let mut chats: Value = if raw.trim().is_empty() {
        json!({"version":1,"conversations":[]})
    } else {
        serde_json::from_str(&raw).map_err(|e| e.to_string())?
    };
    board_operations::normalize_chats(&mut chats)?;
    let rows = chats["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"].as_str() == Some(c));
    let messages: Vec<Value> = rows
        .and_then(|v| v["messages"].as_array())
        .map(|ms| {
            ms.iter()
                .map(|m| {
                    json!([
                        m["id"],
                        m["role"],
                        m["content"],
                        m["error"].as_bool().unwrap_or(false)
                    ])
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ring::digest::digest(
        &ring::digest::SHA256,
        serde_json::to_string(&messages).unwrap().as_bytes(),
    )
    .as_ref()
    .iter()
    .map(|v| format!("{v:02x}"))
    .collect())
}
pub(crate) fn ensure_idle(root:&Path,p:&str,b:&str,c:&str)->Result<(),String>{
    let scope=board_operations::scope(root)?;if leases().lock().map_err(err_string)?.contains_key(&key(&scope,p,b,c)){return Err("对话正在生成或等待保存，请完成后再删除。".into());}Ok(())
}
fn err_string(e:impl std::fmt::Display)->String{e.to_string()}
#[cfg(test)]pub(crate) struct TestLease(String);
#[cfg(test)]impl Drop for TestLease{fn drop(&mut self){leases().lock().unwrap().remove(&self.0);}}
#[cfg(test)]pub(crate) fn test_lease(root:&Path,p:&str,b:&str,c:&str)->TestLease{let key=key(&board_operations::scope(root).unwrap(),p,b,c);claim(&mut leases().lock().unwrap(),key.clone(),"test".into(),"test-token".into(),String::new()).unwrap();TestLease(key)}
fn claim(
    rows: &mut Leases,
    key: String,
    owner: String,
    token: String,
    baseline: String,
) -> Result<(), String> {
    if let Some(existing) = rows.get(&key) {
        if existing.owner != owner || existing.token != token {
            return Err(
                "这段对话已在另一个窗口运行，请等它保存完成后重新打开；当前输入已保留。".into(),
            );
        }
    }
    rows.insert(
        key,
        Lease {
            owner,
            token,
            baseline,
        },
    );
    Ok(())
}
fn release(rows: &mut Leases, key: &str, owner: &str, token: &str) {
    if rows
        .get(key)
        .is_some_and(|lease| lease.owner == owner && lease.token == token)
    {
        rows.remove(key);
    }
}
pub(crate) fn validate_at(
    root: &Path,
    p: &str,
    b: &str,
    c: &str,
    scope: &str,
    owner: &str,
    token: Option<&str>,
) -> Result<(), String> {
    let rows = leases().lock().map_err(|e| e.to_string())?;
    if let Some(lease) = rows.get(&key(scope, p, b, c)) {
        if lease.owner != owner || Some(lease.token.as_str()) != token {
            return Err("对话正在另一个控制器运行，原始记录未覆盖。".into());
        }
        if fingerprint_at(root, p, b, c)? != lease.baseline {
            return Err(
                "原始对话已被同步或其他窗口更改，回答仍保留在窗口；请先导出当前对话并重新载入。"
                    .into(),
            );
        }
    } else if token.is_some() {
        return Err("对话运行状态已失效，原始记录未覆盖。".into());
    }
    Ok(())
}
pub(crate) fn saved_at(root: &Path, p: &str, b: &str, c: &str, scope: &str) -> Result<(), String> {
    let baseline = fingerprint_at(root, p, b, c)?;
    let mut rows = leases().lock().map_err(|e| e.to_string())?;
    if let Some(lease) = rows.get_mut(&key(scope, p, b, c)) {
        lease.baseline = baseline;
    }
    Ok(())
}
#[tauri::command]
pub fn chat_generation_validate(
    window: tauri::WebviewWindow,
    project_id: String,
    board_id: String,
    conversation_id: String,
    expected_scope: String,
    token: String,
) -> Result<(), String> {
    let _g = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    board_operations::ensure_scope(&root, &expected_scope)?;
    crate::chat_history::ensure_live(&root,&project_id,&board_id,&conversation_id)?;
    validate_at(
        &root,
        &project_id,
        &board_id,
        &conversation_id,
        &expected_scope,
        window.label(),
        Some(&token),
    )
}
#[tauri::command]
pub fn chat_generation_claim(
    window: tauri::WebviewWindow,
    project_id: String,
    board_id: String,
    conversation_id: String,
    expected_scope: String,
    baseline: String,
    token: String,
) -> Result<(), String> {
    let _g = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    storage::safe_id(&conversation_id)?;
    storage::safe_id(&token)?;
    let root = commands::root()?;
    board_operations::ensure_scope(&root, &expected_scope)?;
    crate::chat_history::ensure_live(&root,&project_id,&board_id,&conversation_id)?;
    if fingerprint_at(&root, &project_id, &board_id, &conversation_id)? != baseline {
        return Err("原始对话已在其他窗口更新，请重新打开这段对话后发送；当前输入已保留。".into());
    }
    let mut rows = leases().lock().map_err(|e| e.to_string())?;
    rows.retain(|_, lease| {
        window
            .app_handle()
            .get_webview_window(&lease.owner)
            .is_some()
    });
    claim(
        &mut rows,
        key(&expected_scope, &project_id, &board_id, &conversation_id),
        window.label().into(),
        token,
        baseline,
    )
}
#[tauri::command]
pub fn chat_generation_release(
    window: tauri::WebviewWindow,
    project_id: String,
    board_id: String,
    conversation_id: String,
    expected_scope: String,
    token: String,
) -> Result<(), String> {
    let mut rows = leases().lock().map_err(|e| e.to_string())?;
    let key = key(&expected_scope, &project_id, &board_id, &conversation_id);
    release(&mut rows, &key, window.label(), &token);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_generation_per_conversation_and_owner() {
        let mut rows = Leases::new();
        claim(
            &mut rows,
            "c".into(),
            "one".into(),
            "t".into(),
            "hash".into(),
        )
        .unwrap();
        assert!(claim(
            &mut rows,
            "c".into(),
            "two".into(),
            "t2".into(),
            "hash".into()
        )
        .is_err());
        assert!(claim(
            &mut rows,
            "c".into(),
            "one".into(),
            "t2".into(),
            "hash".into()
        )
        .is_err());
        claim(
            &mut rows,
            "other".into(),
            "two".into(),
            "t2".into(),
            "hash".into(),
        )
        .unwrap();
    }
    #[test]
    fn lease_tracks_own_saved_revision_and_rejects_external_changes() {
        let root = std::env::temp_dir().join(storage::new_id("generation_cas"));
        let p = storage::create_project(&root, "synthetic").unwrap();
        let b = storage::create_board(&root, &p.id, "synthetic").unwrap();
        let scope = board_operations::scope(&root).unwrap();
        let key = key(&scope, &p.id, &b.id, "c");
        let baseline = fingerprint_at(&root, &p.id, &b.id, "c").unwrap();
        claim(
            &mut leases().lock().unwrap(),
            key.clone(),
            "owner".into(),
            "token".into(),
            baseline,
        )
        .unwrap();
        validate_at(&root, &p.id, &b.id, "c", &scope, "owner", Some("token")).unwrap();
        assert!(validate_at(&root, &p.id, &b.id, "c", &scope, "other", Some("token")).is_err());
        let path = storage::board_dir(&root, &p.id, &b.id).join("chats.json");
        let bytes=board_operations::merged_chat(&root,&p.id,&b.id,json!({"id":"c","messages":[{"id":"q","role":"user","content":"question"},{"id":"blank","role":"assistant","content":""}]})).unwrap();
        std::fs::write(&path, bytes).unwrap();
        saved_at(&root, &p.id, &b.id, "c", &scope).unwrap();
        validate_at(&root, &p.id, &b.id, "c", &scope, "owner", Some("token")).unwrap();
        let bytes=board_operations::merged_chat(&root,&p.id,&b.id,json!({"id":"c","messages":[{"id":"external","role":"user","content":"external change"}]})).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(validate_at(&root, &p.id, &b.id, "c", &scope, "owner", Some("token")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let mut rows = leases().lock().unwrap();
        release(&mut rows, &key, "other", "token");
        release(&mut rows, &key, "owner", "old-token");
        assert!(rows.contains_key(&key));
        release(&mut rows, &key, "owner", "token");
        assert!(!rows.contains_key(&key));
        drop(rows);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_fingerprint_matches_normalized_ids_without_changing_file() {
        let root = std::env::temp_dir().join(storage::new_id("generation"));
        let p = storage::create_project(&root, "synthetic").unwrap();
        let b = storage::create_board(&root, &p.id, "synthetic").unwrap();
        let raw = r#"{"version":1,"conversations":[{"id":"c","messages":[{"role":"user","content":"中文"}]}]}"#;
        let path = storage::board_dir(&root, &p.id, &b.id).join("chats.json");
        std::fs::write(&path, raw).unwrap();
        let expected = ring::digest::digest(
            &ring::digest::SHA256,
            "[[\"c_m_0\",\"user\",\"中文\",false]]".as_bytes(),
        )
        .as_ref()
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect::<String>();
        assert_eq!(fingerprint_at(&root, &p.id, &b.id, "c").unwrap(), expected);
        assert_eq!(std::fs::read_to_string(path).unwrap(), raw);
        std::fs::remove_dir_all(root).unwrap();
    }
}
