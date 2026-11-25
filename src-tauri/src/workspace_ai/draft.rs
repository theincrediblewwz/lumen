use super::layout::{Bounds, LayoutJob, PreviewDocument, SourceBoard};
use super::{operations::*, read_bytes, Change, Destination, Files, Prepared, Revisions};
use crate::{
    documents,
    project_canvas::{self, covers, tags::TagDefinition, Layout},
    storage::{self, BoardFile, IndexFile, ProjectFile},
    workspace_editing,
};
use serde::de::DeserializeOwned;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

mod canvas;
pub(super) mod resources;

type BoardKey = (String, String);

struct BoardDraft {
    board: BoardFile,
    original_nodes: Vec<storage::BoardNode>,
}

struct LayoutIntent {
    node_ids: Option<Vec<String>>,
    direction: LayoutDirection,
    spacing: LayoutSpacing,
    reason: String,
}

pub(super) struct Draft<'a> {
    root: &'a Path,
    index: IndexFile,
    layout: Layout,
    covers: covers::CoverStore,
    projects: BTreeMap<String, ProjectFile>,
    boards: BTreeMap<BoardKey, BoardDraft>,
    dirty_projects: BTreeSet<String>,
    dirty_boards: BTreeSet<BoardKey>,
    check_nodes: BTreeSet<(BoardKey, String)>,
    index_changed: bool,
    layout_changed: bool,
    covers_changed: bool,
    aliases: BTreeMap<String, String>,
    observed: Revisions,
    files: Files,
    changes: Vec<Change>,
    destinations: Vec<Destination>,
    created_projects: BTreeSet<String>,
    layouts: BTreeMap<BoardKey, LayoutIntent>,
    attachment_sources: BTreeMap<String, SourceBoard>,
}

impl<'a> Draft<'a> {
    pub(super) fn new(root: &'a Path) -> Result<Self, String> {
        let mut observed = Revisions::new();
        let index: IndexFile = load(root, &mut observed, "index.json")?.unwrap_or_default();
        let layout = observe(root, &mut observed, project_canvas::FILE)?
            .map(|bytes| project_canvas::parse(&bytes, &index))
            .transpose()?
            .unwrap_or_default();
        let covers = observe(root, &mut observed, covers::FILE)?
            .map(|bytes| covers::parse(&bytes))
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            root,
            index,
            layout,
            covers,
            observed,
            projects: BTreeMap::new(),
            boards: BTreeMap::new(),
            dirty_projects: BTreeSet::new(),
            dirty_boards: BTreeSet::new(),
            check_nodes: BTreeSet::new(),
            index_changed: false,
            layout_changed: false,
            covers_changed: false,
            aliases: BTreeMap::new(),
            files: Files::new(),
            changes: Vec::new(),
            destinations: Vec::new(),
            created_projects: BTreeSet::new(),
            layouts: BTreeMap::new(),
            attachment_sources: BTreeMap::new(),
        })
    }

    pub(super) fn run(
        mut self,
        batch: Batch,
        id: String,
        scope: String,
    ) -> Result<Prepared, String> {
        if batch.schema != SCHEMA {
            return Err("工作区方案的格式版本不受支持".into());
        }
        if !(1..=160).contains(&batch.operations.len()) {
            return Err("一批方案需要包含 1 到 160 项操作".into());
        }
        for (index, op) in batch.operations.into_iter().enumerate() {
            self.apply(op)
                .map_err(|error| format!("第 {} 项操作 · {error}", index + 1))?;
        }
        self.finish(id, scope)
    }

    fn apply(&mut self, op: Operation) -> Result<(), String> {
        match op {
            Operation::CreateProject {
                key,
                name,
                parent_id,
                position,
            } => {
                let parent = parent_id
                    .as_deref()
                    .map(|value| self.project_id(value))
                    .transpose()?;
                let name = name_text(&name, 160)?;
                let (meta, project) = storage::new_project(&mut self.index, &name);
                self.alias(&key, &meta.id)?;
                self.layout.reparent(&meta.id, parent)?;
                if let Some(position) = position {
                    self.layout.place_project(&meta.id, position)?;
                }
                self.index_changed = true;
                self.layout_changed |= self.layout.parent(&meta.id).is_some() || position.is_some();
                self.dirty_projects.insert(meta.id.clone());
                self.created_projects.insert(meta.id.clone());
                self.projects.insert(meta.id.clone(), project);
                self.note("新建项目", self.project_trail(&meta.id));
                self.destinations.push(Destination {
                    project_id: meta.id,
                    board_id: None,
                    name,
                });
            }
            Operation::RenameProject { project_id, name } => {
                let id = self.project_id(&project_id)?;
                let name = name_text(&name, 160)?;
                let previous = self.project_trail(&id);
                let project = self.project(&id)?;
                project.name = name.clone();
                project.updated_at = storage::now_iso();
                self.index
                    .projects
                    .iter_mut()
                    .find(|p| p.id == id)
                    .unwrap()
                    .name = name.clone();
                self.index_changed = true;
                self.dirty_projects.insert(id);
                self.note("重命名项目", format!("{previous} → {name}"));
            }
            Operation::MoveProject {
                project_id,
                parent_id,
                position,
            } => {
                let id = self.project_id(&project_id)?;
                let parent = parent_id
                    .as_deref()
                    .map(|value| self.project_id(value))
                    .transpose()?;
                let previous = self.project_trail(&id);
                self.layout.reparent(&id, parent)?;
                if let Some(position) = position {
                    self.layout.place_project(&id, position)?;
                }
                self.layout_changed = true;
                self.note(
                    "移动或摆放项目",
                    format!("{previous} → {}", self.project_trail(&id)),
                );
            }
            Operation::RemoveProject {
                project_id,
                include_children,
            } => self.remove_project(&project_id, include_children)?,
            Operation::ProjectLink {
                from,
                to,
                label,
                remove,
            } => {
                let from = self.project_id(&from)?;
                let to = self.project_id(&to)?;
                let location = format!(
                    "{} → {}",
                    self.project_trail(&from),
                    self.project_trail(&to)
                );
                self.layout.put_relation(from, to, !remove, label.clone())?;
                self.layout_changed = true;
                self.record(
                    if remove {
                        "移除项目连线"
                    } else {
                        "设置项目连线"
                    },
                    location,
                    None,
                    label,
                    remove,
                );
            }
            Operation::CreateBoard {
                key,
                project_id,
                name,
                position,
            } => {
                let project_id = self.project_id(&project_id)?;
                let name = name_text(&name, 160)?;
                let (meta, board) = storage::new_board(self.project(&project_id)?, &name);
                self.alias(&key, &meta.id)?;
                self.dirty_projects.insert(project_id.clone());
                let id = (project_id.clone(), meta.id.clone());
                self.dirty_boards.insert(id.clone());
                self.boards.insert(
                    id,
                    BoardDraft {
                        board,
                        original_nodes: vec![],
                    },
                );
                if let Some(position) = position {
                    self.layout.place_board(&project_id, &meta.id, position)?;
                    self.layout_changed = true;
                }
                self.note(
                    "新建白板",
                    format!("{} / {name}", self.project_trail(&project_id)),
                );
                self.destinations.push(Destination {
                    project_id,
                    board_id: Some(meta.id),
                    name,
                });
            }
            Operation::UpdateBoard {
                board,
                name,
                position,
                appearance,
            } => {
                let key = self.board_key(&board)?;
                let location = self.board_trail(&key);
                if let Some(name) = name {
                    let name = name_text(&name, 160)?;
                    self.board_mut(&key).name = name.clone();
                    let project = self.project(&key.0)?;
                    let meta = project.boards.iter_mut().find(|b| b.id == key.1).unwrap();
                    meta.name = name.clone();
                    meta.updated_at = storage::now_iso();
                    project.updated_at = meta.updated_at.clone();
                    self.dirty_projects.insert(key.0.clone());
                    self.note("重命名白板", format!("{location} → {name}"));
                }
                if let Some(position) = position {
                    self.layout.place_board(&key.0, &key.1, position)?;
                    self.layout_changed = true;
                    self.note(
                        "摆放白板",
                        format!("{location} · ({}, {})", position.x, position.y),
                    );
                }
                if let Some(appearance) = appearance {
                    self.appearance(&key, location, appearance)?;
                }
            }
            Operation::RemoveBoard { board } => {
                let key = self.board_key(&board)?;
                let location = self.board_trail(&key);
                let project = self.project(&key.0)?;
                project.boards.retain(|b| b.id != key.1);
                project.updated_at = storage::now_iso();
                self.dirty_projects.insert(key.0.clone());
                self.layout.forget_board(&key.0, &key.1);
                self.covers.remove(&format!("{}/{}", key.0, key.1));
                self.covers_changed = true;
                self.layout_changed = true;
                self.remove_board_draft(&key)?;
                self.record("移除白板", location, None, None, true);
            }
            Operation::SetCover { target, cover_id } => {
                if matches!(target, Target::Node { .. }) {
                    return Err("封面适用于项目和白板".into());
                }
                let (key, location) = self.target(&target)?;
                if let Some(id) = &cover_id {
                    covers::check_preset(id)?;
                    self.covers.insert(key, id.clone());
                } else {
                    self.covers.remove(&key);
                }
                self.covers_changed = true;
                self.record(
                    "设置封面",
                    location,
                    None,
                    Some(cover_id.unwrap_or_else(|| "默认封面".into())),
                    false,
                );
            }
            Operation::SetPinned { target, pinned } => {
                if matches!(target, Target::Node { .. }) {
                    return Err("收藏适用于项目和白板".into());
                }
                let (key, location) = self.target(&target)?;
                self.layout.pins.insert(key, pinned);
                self.layout_changed = true;
                self.note(
                    if pinned {
                        "收藏并置顶"
                    } else {
                        "取消收藏置顶"
                    },
                    location,
                );
            }
            Operation::CreateTag { key, name, color } => {
                let id = storage::new_id("tag");
                self.alias(&key, &id)?;
                self.define_tag(id, name.trim().into(), color)?;
            }
            Operation::EditTag {
                tag_id,
                name,
                color,
            } => {
                let id = self.resolve(&tag_id)?;
                let current = self
                    .layout
                    .tags
                    .definitions()
                    .get(&id)
                    .ok_or("只能编辑自定义标签")?;
                self.define_tag(
                    id,
                    name.map(|n| n.trim().to_owned())
                        .unwrap_or_else(|| current.name.clone()),
                    color.unwrap_or_else(|| current.color.clone()),
                )?;
            }
            Operation::RemoveTag { tag_id } => {
                let id = self.resolve(&tag_id)?;
                let name = self.tag_name(&id);
                let count = self.layout.tags.remove_definition(&id)?;
                self.layout_changed = true;
                self.record(
                    "移除自定义标签",
                    format!("{name} · {count} 处使用"),
                    None,
                    None,
                    true,
                );
            }
            Operation::AssignTags {
                target,
                add,
                remove,
            } => {
                let (key, location) = self.target(&target)?;
                let add = add
                    .iter()
                    .map(|value| self.resolve(value))
                    .collect::<Result<BTreeSet<_>, _>>()?;
                let remove = remove
                    .iter()
                    .map(|value| self.resolve(value))
                    .collect::<Result<BTreeSet<_>, _>>()?;
                if !add.is_disjoint(&remove) {
                    return Err("同一个标签不能同时添加和移除".into());
                }
                let mut tags = self.layout.tags.assigned(&key).cloned().unwrap_or_default();
                let display = |tags: &BTreeSet<String>| {
                    tags.iter()
                        .map(|id| self.tag_name(id))
                        .collect::<Vec<_>>()
                        .join("、")
                };
                let before = display(&tags);
                tags.retain(|tag| !remove.contains(tag));
                tags.extend(add);
                let after = display(&tags);
                self.layout.tags.set(key, tags)?;
                self.layout_changed = true;
                self.record("设置标签", location, Some(before), Some(after), false);
            }
            Operation::ArrangeNodes {
                board,
                node_ids,
                direction,
                spacing,
                reason,
            } => {
                let key = self.board_key(&board)?;
                if self.layouts.contains_key(&key) {
                    return Err("同一白板在一批方案中只安排一次布局".into());
                }
                if node_ids
                    .as_ref()
                    .is_some_and(|ids| ids.is_empty() || ids.len() > 160)
                {
                    return Err("每次布局需要 1 到 160 个指定节点".into());
                }
                let node_ids = node_ids
                    .map(|ids| {
                        ids.iter()
                            .map(|id| self.resolve(id))
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()?;
                let reason = name_text(&reason, 320)?;
                self.layouts.insert(
                    key,
                    LayoutIntent {
                        node_ids,
                        direction,
                        spacing,
                        reason,
                    },
                );
            }
            op => self.apply_canvas_or_resource(op)?,
        }
        Ok(())
    }

    fn finish(mut self, id: String, scope: String) -> Result<Prepared, String> {
        for (key, node) in &self.check_nodes {
            let Some(n) = self
                .boards
                .get(key)
                .and_then(|b| b.board.nodes.iter().find(|n| &n.id == node))
            else {
                continue;
            };
            if n.title.trim().is_empty()
                && n.summary.as_deref().is_none_or(|s| s.trim().is_empty())
                && n.docs.iter().all(|doc| doc.path == question_path(&n.id))
                && !n.extra.contains_key("flow")
            {
                return Err("节点需要有标题、正文、附件或子流程".into());
            }
        }
        let layout_jobs = self.prepare_layouts()?;
        for key in &self.dirty_boards {
            let state = self.boards.get_mut(key).unwrap();
            state.board.version = storage::FORMAT_VERSION;
            state.board.updated_at = storage::now_iso();
            let (questions, _) = workspace_editing::prepare_questions(
                self.root,
                &mut state.board,
                &state.original_nodes,
            )?;
            self.files.extend(questions);
            self.files
                .insert(board_path(key), super::encode(&state.board)?);
        }
        for project in &self.dirty_projects {
            self.files.insert(
                project_path(project),
                super::encode(&self.projects[project])?,
            );
        }
        if self.index_changed {
            self.files
                .insert("index.json".into(), super::encode(&self.index)?);
        }
        if self.layout_changed {
            self.files
                .insert(project_canvas::FILE.into(), self.layout.bytes()?);
        }
        if self.covers_changed {
            self.files
                .insert(covers::FILE.into(), covers::bytes(&self.covers)?);
        }
        self.destinations.retain_mut(|item| {
            let Some(folder) = self.index.projects.iter().find(|p| p.id == item.project_id) else {
                return false;
            };
            if let Some(board) = &item.board_id {
                let Some(meta) = self.projects[&item.project_id]
                    .boards
                    .iter()
                    .find(|b| b.id == *board)
                else {
                    return false;
                };
                item.name = meta.name.clone();
            } else {
                item.name = folder.name.clone();
            }
            true
        });
        Prepared::new(
            self.root,
            id,
            scope,
            self.observed,
            self.files,
            self.changes,
            self.destinations,
            layout_jobs,
        )
    }

    fn prepare_layouts(&mut self) -> Result<Vec<LayoutJob>, String> {
        let mut jobs = Vec::new();
        let mut selected_count = 0;
        for (key, intent) in std::mem::take(&mut self.layouts) {
            let board = &self.boards.get(&key).ok_or("布局白板已移除")?.board;
            let top_level: BTreeMap<_, _> = board
                .nodes
                .iter()
                .filter(|node| !node.extra.contains_key("flowOwnerId"))
                .map(|node| (node.id.as_str(), node))
                .collect();
            let ids = intent.node_ids.unwrap_or_else(|| {
                board
                    .nodes
                    .iter()
                    .filter(|node| top_level.contains_key(node.id.as_str()))
                    .map(|node| node.id.clone())
                    .collect()
            });
            selected_count += ids.len();
            if ids.is_empty() || selected_count > 160 {
                return Err("一批自动布局需要 1 到 160 个主白板节点，请选择节点或分批处理".into());
            }
            let selected: BTreeSet<_> = ids.iter().map(String::as_str).collect();
            if selected.len() != ids.len() {
                return Err("布局节点不能重复".into());
            }
            let nodes = ids
                .iter()
                .map(|id| {
                    top_level
                        .get(id.as_str())
                        .map(|node| (**node).clone())
                        .ok_or("只能排列仍存在的主白板节点，子流程顺序使用 set_flow")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let reserved = top_level
                .iter()
                .filter(|(id, _)| !selected.contains(*id))
                .map(|(_, node)| Bounds::reserved(node))
                .reduce(Bounds::union);
            let edges = board
                .edges
                .iter()
                .filter(|edge| {
                    selected.contains(edge.from.as_str()) && selected.contains(edge.to.as_str())
                })
                .cloned()
                .collect();
            let appearance = board.extra.get("appearance").cloned();
            let name = board.name.clone();
            let mut previews = BTreeMap::new();
            let mut seen_docs = BTreeSet::new();
            for node in &nodes {
                let question = question_path(&node.id);
                let Some(doc) = node.docs.iter().find(|doc| doc.path != question) else {
                    continue;
                };
                let path = resources::doc_path(&key, &doc.path);
                if !seen_docs.insert(&doc.path) {
                    continue;
                }
                let staged = self.files.contains_key(&path);
                let raw = self.file(&path)?.ok_or("布局中首个挂载资料已不存在")?;
                if staged {
                    let decoded = storage::decode_text(&raw);
                    let (attachment, markdown) = documents::split(&decoded)?;
                    let source = attachment.map(|_| {
                        self.attachment_sources
                            .get(&path)
                            .cloned()
                            .unwrap_or_else(|| SourceBoard {
                                project_id: key.0.clone(),
                                board_id: key.1.clone(),
                            })
                    });
                    previews.insert(
                        doc.path.clone(),
                        PreviewDocument {
                            markdown: markdown.into(),
                            source,
                        },
                    );
                }
            }
            let placement = match intent.direction {
                LayoutDirection::Down => "从上到下",
                LayoutDirection::Right => "从左到右",
            };
            let density = match intent.spacing {
                LayoutSpacing::Compact => "紧凑",
                LayoutSpacing::Balanced => "适中",
                LayoutSpacing::Airy => "宽松",
            };
            self.record(
                "整理节点布局",
                format!("{name} · {} 个节点", nodes.len()),
                None,
                Some(format!("{placement} · {density}间距\n{}", intent.reason)),
                false,
            );
            self.dirty_boards.insert(key.clone());
            if !self.destinations.iter().any(|destination| {
                destination.project_id == key.0
                    && destination.board_id.as_deref() == Some(key.1.as_str())
            }) {
                self.destinations.push(Destination {
                    project_id: key.0.clone(),
                    board_id: Some(key.1.clone()),
                    name: name.clone(),
                });
            }
            jobs.push(LayoutJob {
                project_id: key.0,
                board_id: key.1,
                name,
                nodes,
                edges,
                appearance,
                reserved,
                direction: intent.direction,
                spacing: intent.spacing,
                reason: intent.reason,
                documents: previews,
            });
        }
        Ok(jobs)
    }

    fn project_id(&self, reference: &str) -> Result<String, String> {
        let id = self.resolve(reference)?;
        self.index
            .projects
            .iter()
            .any(|p| p.id == id)
            .then_some(id)
            .ok_or("项目不在当前资料库中".into())
    }

    fn project(&mut self, id: &str) -> Result<&mut ProjectFile, String> {
        if !self.projects.contains_key(id) {
            let project: ProjectFile =
                load(self.root, &mut self.observed, &project_path(id))?.ok_or("找不到项目文件")?;
            if project.id != id {
                return Err("项目文件的标识不一致".into());
            }
            self.projects.insert(id.into(), project);
        }
        Ok(self.projects.get_mut(id).unwrap())
    }

    fn board_key(&mut self, reference: &BoardRef) -> Result<BoardKey, String> {
        let p = self.project_id(&reference.project_id)?;
        let b = self.resolve(&reference.board_id)?;
        if !self.project(&p)?.boards.iter().any(|item| item.id == b) {
            return Err("白板不属于指定的项目".into());
        }
        let key = (p, b);
        if !self.boards.contains_key(&key) {
            let mut board: BoardFile =
                load(self.root, &mut self.observed, &board_path(&key))?.ok_or("找不到白板文件")?;
            if (board.project_id.as_str(), board.id.as_str()) != (key.0.as_str(), key.1.as_str()) {
                return Err("白板文件的标识不一致".into());
            }
            board.extra.remove("_disk_revision");
            self.boards.insert(
                key.clone(),
                BoardDraft {
                    original_nodes: board.nodes.clone(),
                    board,
                },
            );
        }
        Ok(key)
    }

    fn board_mut(&mut self, key: &BoardKey) -> &mut BoardFile {
        self.dirty_boards.insert(key.clone());
        &mut self.boards.get_mut(key).unwrap().board
    }

    fn resolve(&self, reference: &str) -> Result<String, String> {
        if reference.starts_with('@') {
            return self
                .aliases
                .get(reference)
                .cloned()
                .ok_or_else(|| format!("尚未定义引用 {reference}"));
        }
        storage::safe_id(reference).map(str::to_owned)
    }

    fn alias(&mut self, key: &str, id: &str) -> Result<(), String> {
        let alias = key.strip_prefix('@').ok_or("新对象的 key 需要以 @ 开头")?;
        storage::safe_id(alias)?;
        if self.aliases.insert(key.into(), id.into()).is_some() {
            return Err("同一方案内的 key 不能重复".into());
        }
        Ok(())
    }

    fn remove_project(&mut self, reference: &str, include_children: bool) -> Result<(), String> {
        let id = self.project_id(reference)?;
        let location = self.project_trail(&id);
        let subtree = self.layout.subtree(&id);
        if subtree.len() > 1 && !include_children {
            return Err("项目含子项目，需要明确设置 includeChildren 才能整组移除".into());
        }
        if subtree.iter().any(|id| {
            self.dirty_projects.contains(id)
                || self.created_projects.contains(id)
                || self.dirty_boards.iter().any(|(project, _)| project == id)
        }) {
            return Err("同一批中请把修改和移除此项目内的内容分开".into());
        }
        for project in &subtree {
            self.project(project)?;
        }
        let names = subtree
            .iter()
            .map(|id| self.project_trail(id))
            .collect::<Vec<_>>()
            .join("\n");
        let board_count: usize = subtree
            .iter()
            .map(|id| self.projects[id].boards.len())
            .sum();
        self.index.projects.retain(|p| !subtree.contains(&p.id));
        self.layout
            .retain_projects(&self.index.projects.iter().map(|p| p.id.clone()).collect());
        self.covers
            .retain(|key, _| !subtree.contains(key.split('/').next().unwrap_or_default()));
        self.index_changed = true;
        self.layout_changed = true;
        self.covers_changed = true;
        self.record(
            "移除项目",
            format!(
                "{location} · {} 个项目、{board_count} 块白板",
                subtree.len()
            ),
            Some(names),
            None,
            true,
        );
        Ok(())
    }

    fn remove_board_draft(&mut self, key: &BoardKey) -> Result<(), String> {
        if self.dirty_boards.contains(key) {
            return Err("同一批中请把修改和移除此白板分开".into());
        }
        self.boards.remove(key);
        Ok(())
    }

    fn define_tag(&mut self, id: String, name: String, color: String) -> Result<(), String> {
        let existed = self.layout.tags.definitions().contains_key(&id);
        self.layout.tags.define(
            id,
            TagDefinition {
                name: name.clone(),
                color: color.clone(),
            },
        )?;
        self.layout_changed = true;
        self.record(
            if existed {
                "编辑自定义标签"
            } else {
                "新建自定义标签"
            },
            name,
            None,
            Some(color),
            false,
        );
        Ok(())
    }

    fn tag_name(&self, id: &str) -> String {
        self.layout
            .tags
            .definitions()
            .get(id)
            .map(|t| t.name.clone())
            .or_else(|| {
                project_canvas::tags::BUILTIN
                    .iter()
                    .find(|(key, _)| *key == id)
                    .map(|(_, name)| (*name).into())
            })
            .unwrap_or_else(|| id.into())
    }

    fn target(&mut self, target: &Target) -> Result<(String, String), String> {
        match target {
            Target::Project { project_id } => {
                let id = self.project_id(project_id)?;
                let name = self.project_trail(&id);
                Ok((id, name))
            }
            Target::Board { board } => {
                let key = self.board_key(board)?;
                Ok((format!("{}/{}", key.0, key.1), self.board_trail(&key)))
            }
            Target::Node { board, node_id } => {
                let key = self.board_key(board)?;
                let id = self.resolve(node_id)?;
                let node = self.node(&key, &id)?;
                Ok((
                    format!("{}/{}/{id}", key.0, key.1),
                    self.node_trail(&key, node),
                ))
            }
        }
    }

    pub(super) fn project_trail(&self, id: &str) -> String {
        project_trail(&self.index, &self.layout, id)
    }
    fn board_trail(&self, key: &BoardKey) -> String {
        format!(
            "{} / {}",
            self.project_trail(&key.0),
            self.boards[key].board.name
        )
    }
    fn node_trail(&self, key: &BoardKey, node: &storage::BoardNode) -> String {
        let name = if node.title.trim().is_empty() {
            "无标题节点"
        } else {
            &node.title
        };
        format!("{} / {name}", self.board_trail(key))
    }
    fn note(&mut self, action: &str, location: String) {
        self.record(action, location, None, None, false);
    }
    fn record(
        &mut self,
        action: &str,
        location: String,
        before: Option<String>,
        after: Option<String>,
        removes: bool,
    ) {
        self.changes.push(Change {
            action: action.into(),
            location,
            before,
            after,
            removes,
        });
    }
}

pub(super) fn project_trail(index: &IndexFile, layout: &Layout, id: &str) -> String {
    let mut parts = Vec::new();
    let mut current = Some(id);
    while let Some(id) = current {
        let Some(project) = index.projects.iter().find(|p| p.id == id) else {
            break;
        };
        parts.push(project.name.as_str());
        current = layout.parent(id);
    }
    parts.reverse();
    parts.join(" / ")
}

pub(super) fn observe(
    root: &Path,
    observed: &mut Revisions,
    path: &str,
) -> Result<Option<Vec<u8>>, String> {
    let bytes = read_bytes(root, path)?;
    let revision = bytes.as_deref().map(documents::hash);
    if observed
        .get(path)
        .is_some_and(|previous| *previous != revision)
    {
        return Err("资料在读取期间发生变化，请重新生成方案".into());
    }
    observed.insert(path.to_owned(), revision);
    Ok(bytes)
}

pub(super) fn load<T: DeserializeOwned>(
    root: &Path,
    observed: &mut Revisions,
    path: &str,
) -> Result<Option<T>, String> {
    observe(root, observed, path)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|e| format!("资料格式无效 · {e}")))
        .transpose()
}

pub(super) fn project_path(id: &str) -> String {
    format!("{id}/project.json")
}
pub(super) fn board_path(key: &BoardKey) -> String {
    format!("{}/{}/board.json", key.0, key.1)
}
fn question_path(id: &str) -> String {
    format!("docs/question_{id}.md")
}

fn name_text(value: &str, limit: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > limit || value.chars().any(char::is_control) {
        return Err(format!("名称需要在同一行内，长度为 1 到 {limit} 个字符"));
    }
    Ok(value.to_owned())
}

fn markdown_text(value: &str) -> Result<(), String> {
    if value.len() > documents::LIMIT || value.contains('\0') {
        return Err("Markdown 无效或超过 32 MiB".into());
    }
    if documents::split(value)?.0.is_some() {
        return Err("Markdown 正文不能带入独立的附件清单".into());
    }
    Ok(())
}
