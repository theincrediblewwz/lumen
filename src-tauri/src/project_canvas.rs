//! Desktop project tree and positions. Board and document paths remain stable.
use crate::{board_operations as safety, commands, storage, sync};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub(crate) mod covers;
pub(crate) mod tags;

pub(crate) const FILE: &str = "project-canvas.json";
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

impl Position {
    pub(crate) fn check(self) -> Result<(), String> {
        if [self.x, self.y]
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 1_000_000.0)
        {
            return Err("画布位置超出范围".into());
        }
        Ok(())
    }
}

#[derive(Clone, Default, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Placement {
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    position: Option<Position>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Relation {
    pub(crate) from: String,
    pub(crate) to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    version: u8,
    #[serde(default)]
    projects: BTreeMap<String, Placement>,
    #[serde(default)]
    boards: BTreeMap<String, BTreeMap<String, Position>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    relations: Vec<Relation>,
    #[serde(default, skip_serializing_if = "tags::TagStore::is_empty")]
    pub(crate) tags: tags::TagStore,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) pins: BTreeMap<String, bool>,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            version: 1,
            projects: BTreeMap::new(),
            boards: BTreeMap::new(),
            relations: Vec::new(),
            tags: tags::TagStore::default(),
            pins: BTreeMap::new(),
        }
    }
}

impl Layout {
    pub(crate) fn parent(&self, id: &str) -> Option<&str> {
        self.projects.get(id)?.parent_id.as_deref()
    }

    pub(crate) fn project_position(&self, id: &str) -> Option<Position> {
        self.projects.get(id)?.position
    }

    pub(crate) fn board_position(&self, project: &str, board: &str) -> Option<Position> {
        self.boards.get(project)?.get(board).copied()
    }

    pub(crate) fn relations(&self) -> &[Relation] {
        &self.relations
    }

    pub(crate) fn reparent(&mut self, id: &str, parent: Option<String>) -> Result<(), String> {
        if let Some(target) = parent.as_deref() {
            if self.subtree(id).contains(target) {
                return Err("不能将项目移入自身或它的子项目".into());
            }
        }
        if self.parent(id) != parent.as_deref() {
            self.projects.insert(id.into(), Placement { parent_id: parent, position: None });
        }
        Ok(())
    }

    pub(crate) fn place_project(&mut self, id: &str, position: Position) -> Result<(), String> {
        position.check()?;
        self.projects.entry(id.into()).or_default().position = Some(position);
        Ok(())
    }

    pub(crate) fn place_board(&mut self, project: &str, board: &str, position: Position) -> Result<(), String> {
        position.check()?;
        self.boards.entry(project.into()).or_default().insert(board.into(), position);
        Ok(())
    }

    pub(crate) fn forget_board(&mut self, project: &str, board: &str) {
        if let Some(positions) = self.boards.get_mut(project) { positions.remove(board); }
        let key = format!("{project}/{board}");
        self.tags.remove_tree(&key);
        self.pins.remove(&key);
    }

    pub(crate) fn put_relation(&mut self, from: String, to: String, present: bool, label: Option<String>) -> Result<(), String> {
        if from == to || self.parent(&from) != self.parent(&to) {
            return Err("请选择同一画布上的两个项目建立连线".into());
        }
        let label = label.as_deref().map(relation_label).transpose()?;
        let position = self.relations.iter().position(|edge| edge.from == from && edge.to == to);
        match (present, position) {
            (true, None) => self.relations.push(Relation { from, to, label: label.flatten() }),
            (true, Some(index)) => {
                if let Some(label) = label { self.relations[index].label = label; }
            }
            (false, Some(index)) => { self.relations.remove(index); }
            (false, None) => return Err("项目连线已移除".into()),
        }
        Ok(())
    }

    pub(crate) fn subtree(&self, id: &str) -> BTreeSet<String> {
        let mut children = BTreeMap::<&str, Vec<&str>>::new();
        for (child, placement) in &self.projects {
            if let Some(parent) = placement.parent_id.as_deref() {
                children.entry(parent).or_default().push(child);
            }
        }
        let mut included = BTreeSet::new();
        let mut pending = vec![id];
        while let Some(item) = pending.pop() {
            if included.insert(item.to_owned()) {
                if let Some(rows) = children.get(item) {
                    pending.extend(rows);
                }
            }
        }
        included
    }

    pub(crate) fn retain_projects(&mut self, ids: &BTreeSet<String>) {
        self.projects.retain(|id, _| ids.contains(id));
        self.boards.retain(|id, _| ids.contains(id));
        self.relations
            .retain(|edge| ids.contains(&edge.from) && ids.contains(&edge.to));
        self.tags.retain_projects(ids);
        self.pins.retain(|key, _| ids.contains(key.split('/').next().unwrap_or_default()));
        for placement in self.projects.values_mut() {
            if placement
                .parent_id
                .as_ref()
                .is_some_and(|id| !ids.contains(id))
            {
                placement.parent_id = None;
            }
        }
    }

    pub(crate) fn retain_boards(&mut self, owners: &BTreeMap<String, String>) {
        self.boards.retain(|owner, positions| {
            positions.retain(|id, _| owners.get(id) == Some(owner));
            !positions.is_empty()
        });
        self.tags.retain_boards(owners);
        self.pins.retain(|id, _| id.split_once('/').is_none_or(|(project, board)| owners.get(board).is_some_and(|owner| owner == project)));
    }

    pub(crate) fn bytes(&self) -> Result<Vec<u8>, String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("项目画布文件过大".into());
        }
        Ok(bytes)
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("不支持此项目画布文件版本".into());
        }
        let mut checked = BTreeSet::new();
        for (id, placement) in &self.projects {
            storage::safe_id(id)?;
            if let Some(parent) = &placement.parent_id {
                storage::safe_id(parent)?;
            }
            if let Some(point) = placement.position {
                point.check()?;
            }
            let mut visiting = BTreeSet::new();
            let mut current = Some(id.as_str());
            while let Some(item) = current {
                if checked.contains(item) {
                    break;
                }
                if !visiting.insert(item) {
                    return Err("项目画布包含循环嵌套".into());
                }
                current = self.parent(item);
            }
            checked.extend(visiting);
        }
        for (owner, boards) in &self.boards {
            storage::safe_id(owner)?;
            for (id, point) in boards {
                storage::safe_id(id)?;
                point.check()?;
            }
        }
        let mut pairs = BTreeSet::new();
        for edge in &self.relations {
            storage::safe_id(&edge.from)?;
            storage::safe_id(&edge.to)?;
            if edge.from == edge.to || !pairs.insert((&edge.from, &edge.to)) {
                return Err("项目连线的端点无效或重复".into());
            }
            relation_label(edge.label.as_deref().unwrap_or(""))?;
        }
        for id in self.pins.keys() {
            if let Some((project, board)) = id.split_once('/') {
                storage::safe_id(project)?;
                storage::safe_id(board)?;
            } else { storage::safe_id(id)?; }
        }
        self.tags.validate()
    }
}

pub(crate) fn read(root: &Path, index: &storage::IndexFile) -> Result<Layout, String> {
    let path = safety::checked_path(root, FILE)?;
    if !path.exists() {
        return Ok(Layout::default());
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES {
        return Err("项目画布文件过大".into());
    }
    parse(&fs::read(path).map_err(|e| e.to_string())?, index)
}

pub(crate) fn parse(bytes: &[u8], index: &storage::IndexFile) -> Result<Layout, String> {
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err("项目画布文件过大".into()); }
    let mut layout: Layout = serde_json::from_slice(bytes)
        .map_err(|e| format!("无法读取项目画布：{e}"))?;
    layout.validate()?;
    layout.retain_projects(&index.projects.iter().map(|p| p.id.clone()).collect());
    Ok(layout)
}

fn write(root: &Path, layout: &Layout) -> Result<(), String> {
    sync::atomic_bytes(&safety::checked_path(root, FILE)?, &layout.bytes()?)
}

fn require_project(index: &storage::IndexFile, id: &str) -> Result<(), String> {
    storage::safe_id(id)?;
    if index.projects.iter().any(|p| p.id == id) {
        Ok(())
    } else {
        Err("项目已不在此资料库中".into())
    }
}

fn require_board(
    root: &Path,
    index: &storage::IndexFile,
    project: &str,
    id: &str,
) -> Result<(), String> {
    require_project(index, project)?;
    storage::safe_id(id)?;
    if storage::read_project(root, project)?.boards.iter().any(|board| board.id == id) {
        Ok(())
    } else {
        Err("白板已不在此项目中".into())
    }
}

pub(crate) fn create_child(
    root: &Path,
    name: &str,
    parent: &str,
) -> Result<storage::ProjectMeta, String> {
    let index = storage::read_index(root)?;
    require_project(&index, parent)?;
    storage::read_project(root, parent)?;
    let mut layout = read(root, &index)?;
    let (meta, mut writes) = storage::prepare_project(root, name)?;
    layout.projects.insert(
        meta.id.clone(),
        Placement {
            parent_id: Some(parent.to_owned()),
            position: None,
        },
    );
    writes.insert(FILE.into(), layout.bytes()?);
    sync::transaction(root, writes)?;
    Ok(meta)
}

pub(crate) fn require_no_children(root: &Path, id: &str) -> Result<(), String> {
    let layout = read(root, &storage::read_index(root)?)?;
    if layout
        .projects
        .values()
        .any(|p| p.parent_id.as_deref() == Some(id))
    {
        return Err("此项目还有子项目，请先将子项目移出".into());
    }
    Ok(())
}

fn move_project(
    root: &Path,
    id: &str,
    expected_parent: Option<&str>,
    parent: Option<String>,
) -> Result<Layout, String> {
    let index = storage::read_index(root)?;
    require_project(&index, id)?;
    let mut layout = read(root, &index)?;
    if layout.parent(id) != expected_parent {
        return Err("项目所在位置已变化，请重新打开后再移动".into());
    }
    if let Some(target) = parent.as_deref() {
        require_project(&index, target)?;
    }
    if layout.parent(id) != parent.as_deref() {
        layout.reparent(id, parent)?;
        write(root, &layout)?;
    }
    Ok(layout)
}

pub(crate) fn relation_label(value: &str) -> Result<Option<String>, String> {
    let value = value.trim();
    if value.chars().count() > 240 || value.chars().any(char::is_control) {
        return Err("连线名称最多 240 个字符，请写在同一行".into());
    }
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

enum RelationChange {
    Add,
    Remove,
    Label(Option<String>),
}

fn change_relation(
    root: &Path,
    project: Option<&str>,
    from: String,
    to: String,
    change: RelationChange,
) -> Result<Layout, String> {
    let index = storage::read_index(root)?;
    require_project(&index, &from)?;
    require_project(&index, &to)?;
    let mut layout = read(root, &index)?;
    if from == to || layout.parent(&from) != project || layout.parent(&to) != project {
        return Err("请选择同一画布上的两个项目建立连线".into());
    }
    let position = layout
        .relations
        .iter()
        .position(|edge| edge.from == from && edge.to == to);
    match (change, position) {
        (RelationChange::Add, None) => layout.relations.push(Relation {
            from,
            to,
            label: None,
        }),
        (RelationChange::Remove, Some(index)) => {
            layout.relations.remove(index);
        }
        (RelationChange::Label(label), Some(index)) => layout.relations[index].label = label,
        (RelationChange::Label(_), None) => return Err("项目连线已移除".into()),
        _ => return Ok(layout),
    }
    write(root, &layout)?;
    Ok(layout)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TileKind {
    Project,
    Board,
}

#[tauri::command]
pub fn project_canvas_pin(kind: TileKind, id: String, project_id: Option<String>, pinned: bool, expected_scope: String) -> Result<Layout, String> {
    let _io = sync::IO_LOCK.lock().map_err(|error| error.to_string())?;
    let root = commands::root()?;
    safety::ensure_scope(&root, &expected_scope)?;
    let index = storage::read_index(&root)?;
    let key = match kind {
        TileKind::Project => { require_project(&index, &id)?; id }
        TileKind::Board => {
            let owner = project_id.ok_or("请选择白板所属项目")?;
            require_board(&root, &index, &owner, &id)?;
            format!("{owner}/{id}")
        }
    };
    let mut layout = read(&root, &index)?;
    layout.pins.insert(key, pinned);
    write(&root, &layout)?;
    Ok(layout)
}

fn place(
    root: &Path,
    kind: TileKind,
    id: &str,
    project: Option<&str>,
    position: Position,
) -> Result<Layout, String> {
    position.check()?;
    let index = storage::read_index(root)?;
    let mut layout = read(root, &index)?;
    match kind {
        TileKind::Project => {
            require_project(&index, id)?;
            if layout.parent(id) != project {
                return Err("项目已移到另一层，请重新打开后再摆放".into());
            }
            layout.place_project(id, position)?;
        }
        TileKind::Board => {
            let owner = project.ok_or("首页只能放项目")?;
            require_board(root, &index, owner, id)?;
            layout.place_board(owner, id, position)?;
        }
    }
    write(root, &layout)?;
    Ok(layout)
}

/// Sync protocol projects represent whiteboards. A board deletion or an older
/// client projecting just boards must not remove the containing desktop folder.
pub(crate) fn preserve_folders(
    root: &Path,
    writes: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    let Some(bytes) = writes.get("index.json") else {
        return Ok(());
    };
    let mut incoming: storage::IndexFile =
        serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let projected: BTreeSet<_> = incoming.projects.iter().map(|p| p.id.clone()).collect();
    let mut changed = false;
    for folder in storage::read_index(root)?.projects {
        if projected.contains(&folder.id) {
            continue;
        }
        let mut content = storage::read_project(root, &folder.id)?;
        if !content.boards.is_empty() {
            content.boards.clear();
            content.updated_at = storage::now_iso();
            writes.insert(
                format!("{}/project.json", folder.id),
                serde_json::to_vec_pretty(&content).map_err(|e| e.to_string())?,
            );
        }
        incoming.projects.push(folder);
        changed = true;
    }
    if changed {
        writes.insert(
            "index.json".into(),
            serde_json::to_vec_pretty(&incoming).map_err(|e| e.to_string())?,
        );
    }
    Ok(())
}

#[tauri::command]
pub fn project_canvas_read() -> Result<serde_json::Value, String> {
    let _guard = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    let layout = read(&root, &storage::read_index(&root)?)?;
    let scope = safety::scope(&root)?;
    Ok(match covers::read(&root) {
        Ok(covers) => serde_json::json!({ "layout": layout, "scope": scope, "covers": covers }),
        Err(error) => serde_json::json!({ "layout": layout, "scope": scope, "coverError": error }),
    })
}

#[tauri::command]
pub fn project_canvas_place(
    kind: TileKind,
    id: String,
    project_id: Option<String>,
    position: Position,
    expected_scope: String,
) -> Result<Layout, String> {
    let _guard = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    safety::ensure_scope(&root, &expected_scope)?;
    place(&root, kind, &id, project_id.as_deref(), position)
}

#[tauri::command]
pub fn project_canvas_move(
    id: String,
    expected_parent_id: Option<String>,
    parent_id: Option<String>,
    expected_scope: String,
) -> Result<Layout, String> {
    let _guard = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    safety::ensure_scope(&root, &expected_scope)?;
    move_project(&root, &id, expected_parent_id.as_deref(), parent_id)
}

#[tauri::command]
pub fn project_canvas_relate(
    project_id: Option<String>,
    from: String,
    to: String,
    present: bool,
    expected_scope: String,
) -> Result<Layout, String> {
    let _guard = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    safety::ensure_scope(&root, &expected_scope)?;
    let change = if present {
        RelationChange::Add
    } else {
        RelationChange::Remove
    };
    change_relation(&root, project_id.as_deref(), from, to, change)
}

#[tauri::command]
pub fn project_canvas_label(
    project_id: Option<String>,
    from: String,
    to: String,
    label: String,
    expected_scope: String,
) -> Result<Layout, String> {
    let _guard = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    safety::ensure_scope(&root, &expected_scope)?;
    change_relation(
        &root,
        project_id.as_deref(),
        from,
        to,
        RelationChange::Label(relation_label(&label)?),
    )
}

#[cfg(test)]
mod tests;
