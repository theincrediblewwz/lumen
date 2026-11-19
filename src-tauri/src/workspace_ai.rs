//! Preview and apply a workspace plan through the standard library transaction.
use crate::{board_operations, commands, documents, storage, sync};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{ErrorKind, Read},
    path::Path,
    sync::Mutex,
};

mod draft;
mod operations;
pub(crate) mod read;
#[cfg(test)]
mod tests;

const MAX_FILE_BYTES: u64 = 40 * 1024 * 1024;
const MAX_BATCH_BYTES: usize = 2 * 1024 * 1024;
const MAX_CHANGE_BYTES: usize = 24 * 1024 * 1024;
const HISTORY: &str = ".lumen-ai";
const HISTORY_LIMIT: usize = 12;

type Revisions = BTreeMap<String, Option<String>>;
type Files = BTreeMap<String, Vec<u8>>;
type Before = BTreeMap<String, Option<Vec<u8>>>;

static PENDING: Mutex<Option<Prepared>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    id: String,
    changes: Vec<Change>,
    destinations: Vec<Destination>,
}

#[derive(Clone, Serialize)]
struct Change {
    action: String,
    location: String,
    before: Option<String>,
    after: Option<String>,
    removes: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Destination {
    project_id: String,
    board_id: Option<String>,
    name: String,
}

struct Prepared {
    plan: Plan,
    scope: String,
    observed: Revisions,
    before: Before,
    files: Files,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Applied {
    id: String,
    applied_at: String,
    change_count: usize,
    destinations: Vec<Destination>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    applied: Applied,
    entries: Vec<BeforeImage>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BeforeImage {
    path: String,
    before: Option<String>,
    after: String,
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|e| e.to_string())
}

fn read_bytes(root: &Path, path: &str) -> Result<Option<Vec<u8>>, String> {
    let path = board_operations::checked_path(root, path)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err("资料文件不可读或过大".into());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("资料文件超过读取上限".into());
    }
    Ok(Some(bytes))
}

impl Prepared {
    fn new(
        root: &Path,
        id: String,
        scope: String,
        mut observed: Revisions,
        files: Files,
        changes: Vec<Change>,
        destinations: Vec<Destination>,
    ) -> Result<Self, String> {
        let mut before = Before::new();
        let mut writes = Files::new();
        let mut size = 0;
        for (path, after) in files {
            let old = draft::observe(root, &mut observed, &path)?;
            if old.as_ref() == Some(&after) {
                continue;
            }
            size += after.len() + old.as_ref().map_or(0, Vec::len);
            if size > MAX_CHANGE_BYTES {
                return Err("这批变更超过 24 MiB 的事务上限，请分批处理".into());
            }
            before.insert(path.clone(), old);
            writes.insert(path, after);
        }
        if writes.is_empty() {
            return Err("方案与资料库当前内容相同，没有可应用的变更".into());
        }
        Ok(Self {
            plan: Plan {
                id,
                changes,
                destinations,
            },
            scope,
            observed,
            before,
            files: writes,
        })
    }
}

fn prepare_at(root: &Path, batch: Value) -> Result<Prepared, String> {
    if serde_json::to_vec(&batch).map_err(|e| e.to_string())?.len() > MAX_BATCH_BYTES {
        return Err("AI 方案超过 2 MiB，请分批拟定".into());
    }
    let batch = serde_json::from_value(batch).map_err(|e| format!("无法读取 AI 方案 · {e}"))?;
    draft::Draft::new(root)?.run(
        batch,
        storage::new_id("plan"),
        board_operations::scope(root)?,
    )
}

fn commit_at(root: &Path, prepared: &Prepared) -> Result<Applied, String> {
    board_operations::ensure_scope(root, &prepared.scope)?;
    check_revisions(
        root,
        &prepared.observed,
        "资料在预览后发生变化，原方案未应用。请重新生成方案",
    )?;
    let plan = &prepared.plan;
    let applied = Applied {
        id: plan.id.clone(),
        applied_at: storage::now_iso(),
        change_count: plan.changes.len(),
        destinations: plan.destinations.clone(),
    };
    let entries = prepared
        .files
        .iter()
        .map(|(path, after)| BeforeImage {
            path: path.clone(),
            before: prepared.before[path].as_ref().map(|b| STANDARD.encode(b)),
            after: documents::hash(after),
        })
        .collect();
    let mut files = prepared.files.clone();
    files.insert(
        history_path(&plan.id),
        encode(&Receipt {
            applied: applied.clone(),
            entries,
        })?,
    );
    sync::transaction(root, files)?;
    prune(root);
    Ok(applied)
}

fn history_path(id: &str) -> String {
    format!("{HISTORY}/{id}.json")
}

fn history_ids(root: &Path) -> Result<Vec<String>, String> {
    let folder = board_operations::checked_path(root, HISTORY)?;
    let dir = match fs::read_dir(folder) {
        Ok(rows) => rows,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut ids = Vec::new();
    for entry in dir {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Some(id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
        {
            if id.starts_with("plan_")
                && storage::safe_id(id).is_ok()
                && entry.file_type().map_err(|e| e.to_string())?.is_file()
            {
                ids.push(id.to_owned());
            }
        }
    }
    ids.sort_unstable_by(|a, b| b.cmp(a));
    Ok(ids)
}

fn prune(root: &Path) {
    if let Ok(ids) = history_ids(root) {
        for id in ids.into_iter().skip(HISTORY_LIMIT) {
            if let Ok(path) = board_operations::checked_path(root, &history_path(&id)) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn receipt_at(root: &Path, id: &str) -> Result<Receipt, String> {
    storage::safe_id(id)?;
    let bytes = read_bytes(root, &history_path(id))?.ok_or("没有这批变更的撤销记录")?;
    let receipt: Receipt =
        serde_json::from_slice(&bytes).map_err(|e| format!("撤销记录损坏 · {e}"))?;
    if receipt.applied.id != id {
        return Err("撤销记录的标识不一致".into());
    }
    Ok(receipt)
}

fn latest_at(root: &Path) -> Result<Option<Applied>, String> {
    history_ids(root)?
        .first()
        .map(|id| receipt_at(root, id).map(|r| r.applied))
        .transpose()
}

fn data_path(path: &str) -> Result<(), String> {
    let parts: Vec<_> = path.split('/').collect();
    match parts.as_slice() {
        ["index.json" | "project-canvas.json" | "project-covers.json"] => Ok(()),
        [p, "project.json"] => storage::safe_id(p).map(|_| ()),
        [p, b, "board.json"] | [p, b, "docs", _] | [p, b, ".document-history", _, _] => {
            storage::safe_id(p)?;
            storage::safe_id(b)?;
            if parts
                .iter()
                .any(|s| s.is_empty() || matches!(*s, "." | "..") || s.contains(['\\', ':']))
            {
                return Err("撤销记录包含无效路径".into());
            }
            Ok(())
        }
        _ => Err("撤销记录包含无效路径".into()),
    }
}

fn check_revisions(root: &Path, revisions: &Revisions, message: &str) -> Result<(), String> {
    for (path, previous) in revisions {
        data_path(path)?;
        if read_bytes(root, path)?.as_deref().map(documents::hash) != *previous {
            return Err(message.into());
        }
    }
    Ok(())
}

fn undo_at(root: &Path, id: &str) -> Result<(), String> {
    if history_ids(root)?.first().is_none_or(|latest| latest != id) {
        return Err("最近的一批变更已变化，请重新打开 AI 工作区".into());
    }
    let receipt = receipt_at(root, id)?;
    let mut changes = BTreeMap::new();
    let mut directories = BTreeSet::new();
    for entry in receipt.entries {
        data_path(&entry.path)?;
        if read_bytes(root, &entry.path)?
            .as_deref()
            .map(documents::hash)
            .as_deref()
            != Some(&entry.after)
        {
            return Err("应用后资料已有新改动。撤销已停止，后续编辑保留".into());
        }
        let before = entry
            .before
            .map(|s| STANDARD.decode(s).map_err(|_| "撤销记录中的原始数据无效"))
            .transpose()?;
        if before.is_none() {
            if let Some((dir, _)) = entry.path.rsplit_once('/') {
                directories.insert(dir.to_owned());
            }
        }
        if changes.insert(entry.path, before).is_some() {
            return Err("撤销记录包含重复文件".into());
        }
    }
    changes.insert(history_path(id), None);
    sync::transaction_changes(root, changes)?;
    // Keep unrelated files and any directory someone has populated since the apply.
    for dir in directories.iter().rev() {
        if let Ok(path) = board_operations::checked_path(root, dir) {
            let _ = fs::remove_dir(path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_ai_prepare(
    batch: Value,
    expected_scope: String,
    expected_revisions: Revisions,
) -> Result<Plan, String> {
    let _io = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    board_operations::ensure_scope(&root, &expected_scope)?;
    sync::recover(&root)?;
    if expected_revisions.len() > 128 {
        return Err("本轮读取的资料过多，请分批拟定".into());
    }
    check_revisions(
        &root,
        &expected_revisions,
        "本轮读取后资料已有变化，请重新发送请求",
    )?;
    let prepared = prepare_at(&root, batch)?;
    let plan = prepared.plan.clone();
    *PENDING.lock().map_err(|e| e.to_string())? = Some(prepared);
    Ok(plan)
}

#[tauri::command]
pub fn workspace_ai_apply(plan_id: String, expected_scope: String) -> Result<Applied, String> {
    let _io = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    board_operations::ensure_scope(&root, &expected_scope)?;
    sync::recover(&root)?;
    let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
    if let Some(applied) = latest_at(&root)?.filter(|r| r.id == plan_id) {
        return Ok(applied);
    }
    let plan = pending
        .as_ref()
        .filter(|p| p.plan.id == plan_id)
        .ok_or("方案已过期，请重新生成")?;
    let applied = commit_at(&root, plan)?;
    *pending = None;
    Ok(applied)
}

#[tauri::command]
pub fn workspace_ai_discard(plan_id: String) -> Result<(), String> {
    let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
    if pending.as_ref().is_some_and(|p| p.plan.id == plan_id) {
        *pending = None;
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_ai_latest(expected_scope: String) -> Result<Option<Applied>, String> {
    let _io = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    board_operations::ensure_scope(&root, &expected_scope)?;
    sync::recover(&root)?;
    latest_at(&root)
}

#[tauri::command]
pub fn workspace_ai_undo(plan_id: String, expected_scope: String) -> Result<(), String> {
    let _io = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    board_operations::ensure_scope(&root, &expected_scope)?;
    sync::recover(&root)?;
    undo_at(&root, &plan_id)
}
