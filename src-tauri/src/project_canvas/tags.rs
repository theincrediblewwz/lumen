use super::{read, require_project, write, Layout};
use crate::{board_operations as safety, commands, storage, sync};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub(crate) const BUILTIN: [(&str, &str); 6] = [
    ("color_red", "红色"),
    ("color_orange", "橙色"),
    ("color_yellow", "黄色"),
    ("color_green", "绿色"),
    ("color_blue", "蓝色"),
    ("color_purple", "紫色"),
];

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TagDefinition {
    pub(crate) name: String,
    pub(crate) color: String,
}

impl TagDefinition {
    fn validate(&self) -> Result<(), String> {
        if self.name.is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > 40
            || self.name.chars().any(char::is_control)
        {
            return Err("标签名需要有 1 到 40 个字符".into());
        }
        if self.color.len() != 7
            || !self.color.starts_with('#')
            || !self.color.bytes().skip(1).all(|c| c.is_ascii_hexdigit())
        {
            return Err("标签颜色无效".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TagStore {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    definitions: BTreeMap<String, TagDefinition>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    assignments: BTreeMap<String, BTreeSet<String>>,
}

impl TagStore {
    pub(crate) fn definitions(&self) -> &BTreeMap<String, TagDefinition> {
        &self.definitions
    }

    pub(crate) fn assigned(&self, key: &str) -> Option<&BTreeSet<String>> {
        self.assignments.get(key)
    }

    pub(crate) fn define(&mut self, id: String, tag: TagDefinition) -> Result<(), String> {
        self.definitions.insert(id, tag);
        self.validate()
    }

    pub(crate) fn remove_definition(&mut self, id: &str) -> Result<usize, String> {
        if self.definitions.remove(id).is_none() { return Err("只能删除自定义标签".into()); }
        let mut count = 0;
        self.assignments.retain(|_, tags| {
            if tags.remove(id) { count += 1; }
            !tags.is_empty()
        });
        Ok(count)
    }

    pub(crate) fn set(&mut self, key: String, assigned: BTreeSet<String>) -> Result<(), String> {
        if assigned.is_empty() { self.assignments.remove(&key); }
        else { self.assignments.insert(key, assigned); }
        self.validate()
    }

    pub(crate) fn remove_tree(&mut self, key: &str) {
        let prefix = format!("{key}/");
        self.assignments.retain(|path, _| path != key && !path.starts_with(&prefix));
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.definitions.is_empty() && self.assignments.is_empty()
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        let mut names: BTreeSet<_> = BUILTIN.iter().map(|(_, name)| name.to_string()).collect();
        for (id, definition) in &self.definitions {
            storage::safe_id(id)?;
            definition.validate()?;
            if !id.starts_with("tag_") || !names.insert(definition.name.to_lowercase()) {
                return Err("标签标识无效或名称重复".into());
            }
        }
        for (key, assigned) in &self.assignments {
            let parts: Vec<_> = key.split('/').collect();
            if parts.len() > 3 {
                return Err("标签归属无效".into());
            }
            for part in parts {
                storage::safe_id(part)?;
            }
            for id in assigned {
                if !self.definitions.contains_key(id)
                    && !BUILTIN.iter().any(|(built_in, _)| *built_in == id)
                {
                    return Err("存在未定义的标签".into());
                }
            }
        }
        Ok(())
    }

    pub(super) fn retain_projects(&mut self, ids: &BTreeSet<String>) {
        self.assignments
            .retain(|path, _| ids.contains(path.split('/').next().unwrap_or("")));
    }

    pub(super) fn retain_boards(&mut self, owners: &BTreeMap<String, String>) {
        self.assignments.retain(|path, _| {
            let mut parts = path.split('/');
            let project = parts.next();
            parts
                .next()
                .is_none_or(|board| owners.get(board).map(String::as_str) == project)
        });
    }

    pub(crate) fn retain_used_definitions(&mut self) {
        let used: BTreeSet<_> = self.assignments.values().flatten().collect();
        self.definitions.retain(|id, _| used.contains(id));
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TagTarget {
    Project {
        id: String,
    },
    Board {
        project_id: String,
        id: String,
    },
    Node {
        project_id: String,
        board_id: String,
        id: String,
    },
}

impl TagTarget {
    fn key(&self, root: &Path, index: &storage::IndexFile) -> Result<String, String> {
        let (project, board, node) = match self {
            Self::Project { id } => (id, None, None),
            Self::Board { project_id, id } => (project_id, Some(id), None),
            Self::Node {
                project_id,
                board_id,
                id,
            } => (project_id, Some(board_id), Some(id)),
        };
        require_project(index, project)?;
        let Some(board) = board else {
            return Ok(project.clone());
        };
        storage::safe_id(board)?;
        if !storage::read_project(root, project)?
            .boards
            .iter()
            .any(|x| x.id == *board)
        {
            return Err("白板已不在此项目中".into());
        }
        let Some(node) = node else {
            return Ok(format!("{project}/{board}"));
        };
        storage::safe_id(node)?;
        if !storage::load_board(root, project, board)?
            .nodes
            .iter()
            .any(|x| x.id == *node)
        {
            return Err("节点已不在此白板中".into());
        }
        Ok(format!("{project}/{board}/{node}"))
    }
}

fn assign(
    root: &Path,
    target: &TagTarget,
    assigned: BTreeSet<String>,
    new_tags: BTreeMap<String, TagDefinition>,
) -> Result<Layout, String> {
    let index = storage::read_index(root)?;
    let mut layout = read(root, &index)?;
    let key = target.key(root, &index)?;
    for (id, tag) in new_tags {
        if layout
            .tags
            .definitions
            .get(&id)
            .is_some_and(|old| old != &tag)
        {
            return Err("此标签已变化，请重新打开标签面板".into());
        }
        layout.tags.definitions.insert(id, tag);
    }
    layout.tags.set(key, assigned)?;
    write(root, &layout)?;
    Ok(layout)
}

#[tauri::command]
pub fn project_canvas_tags(
    target: TagTarget,
    assigned: BTreeSet<String>,
    new_tags: BTreeMap<String, TagDefinition>,
    expected_scope: String,
) -> Result<Layout, String> {
    let _guard = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    safety::ensure_scope(&root, &expected_scope)?;
    assign(&root, &target, assigned, new_tags)
}

#[cfg(test)]
mod tests;
