use super::{draft, operations::BoardRef, Revisions};
use crate::{
    board_operations, commands, documents,
    project_canvas::{self, covers, tags, Layout},
    storage::{self, BoardFile, DocRef, IndexFile, ProjectFile},
    sync,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

const PAGE_SIZE: usize = 12;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Query {
    Projects {
        parent_id: Option<String>,
        #[serde(default)]
        root_only: bool,
        query: Option<String>,
        offset: Option<usize>,
    },
    Boards {
        project_id: String,
        query: Option<String>,
        offset: Option<usize>,
    },
    ProjectLinks {
        parent_id: Option<String>,
        offset: Option<usize>,
    },
    Nodes {
        board: BoardRef,
        query: Option<String>,
        offset: Option<usize>,
    },
    Edges {
        board: BoardRef,
        offset: Option<usize>,
    },
    Attachments {
        board: BoardRef,
        node_id: String,
        offset: Option<usize>,
    },
    Markdown {
        board: BoardRef,
        node_id: String,
        document_id: Option<String>,
        offset: Option<usize>,
        length: Option<usize>,
    },
    Tags {
        offset: Option<usize>,
    },
    Covers {
        offset: Option<usize>,
    },
}

#[derive(Serialize)]
pub struct View {
    data: Value,
    revisions: Revisions,
}

pub(super) fn read_at(
    root: &Path,
    query: Query,
    share_board_contents: bool,
) -> Result<View, String> {
    if matches!(
        query,
        Query::Nodes { .. }
            | Query::Edges { .. }
            | Query::Attachments { .. }
            | Query::Markdown { .. }
    ) && !share_board_contents
    {
        return Err("用户尚未选中允许读取白板内容".into());
    }
    let mut revisions = Revisions::new();
    let index: IndexFile = draft::load(root, &mut revisions, "index.json")?.unwrap_or_default();
    let layout = draft::observe(root, &mut revisions, project_canvas::FILE)?
        .map(|bytes| project_canvas::parse(&bytes, &index))
        .transpose()?
        .unwrap_or_default();
    let data = match query {
        Query::Projects {
            parent_id,
            root_only,
            query,
            offset,
        } => {
            if let Some(parent) = &parent_id {
                require_project(&index, parent)?;
            }
            let rows = index
                .projects
                .iter()
                .filter(|p| {
                    let parent = layout.parent(&p.id);
                    parent_id.as_deref().is_none_or(|id| parent == Some(id))
                        && (!root_only || parent.is_none())
                        && matches_name(&p.name, &query)
                })
                .collect::<Vec<_>>();
            let artwork = read_covers(root, &mut revisions)?;
            page(&rows, offset, |p| {
                json!({
                    "projectId":p.id,"name":part(&p.name, 200),"path":part(&draft::project_trail(&index,&layout,&p.id),360),
                    "parentId":layout.parent(&p.id),"position":layout.project_position(&p.id),
                    "tagIds":tag_ids(&layout,&p.id),"coverId":artwork.get(&p.id),
                    "pinned":layout.pins.get(&p.id),
                })
            })
        }
        Query::Boards {
            project_id,
            query,
            offset,
        } => {
            let project = load_project(root, &mut revisions, &index, &project_id)?;
            let artwork = read_covers(root, &mut revisions)?;
            let rows = project
                .boards
                .iter()
                .filter(|b| matches_name(&b.name, &query))
                .collect::<Vec<_>>();
            page(&rows, offset, |b| {
                let key = format!("{project_id}/{}", b.id);
                json!({"projectId":project_id,"boardId":b.id,"name":part(&b.name,200),"position":layout.board_position(&project_id,&b.id),
                    "tagIds":tag_ids(&layout,&key),"coverId":artwork.get(&key),"pinned":layout.pins.get(&key)})
            })
        }
        Query::ProjectLinks { parent_id, offset } => {
            if let Some(id) = &parent_id {
                require_project(&index, id)?;
            }
            let rows = layout
                .relations()
                .iter()
                .filter(|e| {
                    layout.parent(&e.from) == parent_id.as_deref()
                        && layout.parent(&e.to) == parent_id.as_deref()
                })
                .collect::<Vec<_>>();
            page(&rows, offset, |e| json!(e))
        }
        Query::Nodes {
            board,
            query,
            offset,
        } => {
            let graph = load_board(root, &mut revisions, &index, &board)?;
            let rows = graph
                .nodes
                .iter()
                .filter(|n| {
                    matches_name(&n.title, &query)
                        || n.summary
                            .as_ref()
                            .is_some_and(|s| matches_name(&part(s, 4000), &query))
                })
                .collect::<Vec<_>>();
            let mut data = page(&rows, offset, |n| {
                let target = format!("{}/{}/{}", board.project_id, board.board_id, n.id);
                let step_ids = n
                    .extra
                    .get("flow")
                    .and_then(|f| f.get("nodeIds"))
                    .and_then(Value::as_array);
                json!({"nodeId":n.id,"title":part(&n.title,240),"summary":n.summary.as_deref().map(|s| part(s, 220)),
                    "position":{"x":n.x,"y":n.y},"width":n.w,"height":n.extra.get("h"),"color":n.color,
                    "flowOwnerId":n.extra.get("flowOwnerId"),"flowSteps":step_ids.map(|ids|ids.len()),
                    "flowStepIds":step_ids.map(|ids|ids.iter().take(24).collect::<Vec<_>>()),
                    "flowIndex":flow_index(&graph,n),"attachments":n.docs.iter().filter(|d|d.path != question_path(&n.id)).count(),
                    "tagIds":tag_ids(&layout,&target)})
            });
            data["appearance"] = graph
                .extra
                .get("appearance")
                .cloned()
                .unwrap_or(Value::Null);
            data
        }
        Query::Edges { board, offset } => {
            let graph = load_board(root, &mut revisions, &index, &board)?;
            page(&graph.edges, offset, |e| {
                json!({"edgeId":e.id,"from":e.from,"to":e.to,"directed":e.directed,
                "label":e.label.as_deref().map(|s|part(s,240)),"route":e.extra.get("route")})
            })
        }
        Query::Attachments {
            board,
            node_id,
            offset,
        } => {
            let graph = load_board(root, &mut revisions, &index, &board)?;
            let node = graph
                .nodes
                .iter()
                .find(|n| n.id == node_id)
                .ok_or("节点不在指定白板中")?;
            let rows = node
                .docs
                .iter()
                .filter(|doc| doc.path != question_path(&node.id))
                .collect::<Vec<_>>();
            page(&rows, offset, |doc| doc_info(doc))
        }
        Query::Markdown {
            board,
            node_id,
            document_id,
            offset,
            length,
        } => {
            let graph = load_board(root, &mut revisions, &index, &board)?;
            let node = graph
                .nodes
                .iter()
                .find(|n| n.id == node_id)
                .ok_or("节点不在指定白板中")?;
            let offset = offset.unwrap_or(0);
            let length = length.unwrap_or(1800).clamp(1, 3600);
            if let Some(id) = document_id {
                let doc = draft::resources::find_doc(node, &id)?;
                let _ = documents::doc_path(root, &board.project_id, &board.board_id, &doc.path)?;
                let path = format!("{}/{}/{}", board.project_id, board.board_id, doc.path);
                let raw = draft::observe(root, &mut revisions, &path)?.ok_or("附件文件已不存在")?;
                let decoded = storage::decode_text(&raw);
                let (metadata, body) = documents::split(&decoded)?;
                let mut range = text_page(body, offset, length);
                range["revision"] = json!(documents::hash(&raw));
                range["editable"] = json!(
                    !doc.path.starts_with("docs/sticker_")
                        && (doc.path.ends_with(".md") || doc.path.ends_with(".markdown"))
                        && metadata.as_ref().is_none_or(|m| m.kind != "pdf")
                        && std::str::from_utf8(&raw).is_ok()
                );
                range
            } else {
                text_page(node.summary.as_deref().unwrap_or(""), offset, length)
            }
        }
        Query::Tags { offset } => {
            let builtin = tags::BUILTIN.iter().zip(["#e0503a","#e08a2b","#d4b106","#3a9d5d","#3b82c4","#8b5cf6"])
                .map(|((id, name), color)| json!({"tagId":id,"name":name,"color":color,"builtin":true}));
            let custom = layout.tags.definitions().iter().map(
                |(id, tag)| json!({"tagId":id,"name":tag.name,"color":tag.color,"builtin":false}),
            );
            let rows = builtin.chain(custom).collect::<Vec<_>>();
            page(&rows, offset, Value::clone)
        }
        Query::Covers { offset } => page(&covers::presets()?, offset, |cover| json!(cover)),
    };
    Ok(View { data, revisions })
}

fn require_project(index: &IndexFile, id: &str) -> Result<(), String> {
    storage::safe_id(id)?;
    if index.projects.iter().any(|p| p.id == id) {
        Ok(())
    } else {
        Err("项目不在当前资料库中".into())
    }
}

fn load_project(
    root: &Path,
    revisions: &mut Revisions,
    index: &IndexFile,
    id: &str,
) -> Result<ProjectFile, String> {
    require_project(index, id)?;
    let project: ProjectFile =
        draft::load(root, revisions, &draft::project_path(id))?.ok_or("找不到项目文件")?;
    if project.id != id {
        return Err("项目文件的标识不一致".into());
    }
    Ok(project)
}

fn load_board(
    root: &Path,
    revisions: &mut Revisions,
    index: &IndexFile,
    board: &BoardRef,
) -> Result<BoardFile, String> {
    let project = load_project(root, revisions, index, &board.project_id)?;
    let id = storage::safe_id(&board.board_id)?;
    if !project.boards.iter().any(|b| b.id == id) {
        return Err("白板不属于指定的项目".into());
    }
    let graph: BoardFile = draft::load(
        root,
        revisions,
        &draft::board_path(&(project.id, id.into())),
    )?
    .ok_or("找不到白板文件")?;
    if graph.id != id || graph.project_id != board.project_id {
        return Err("白板文件的标识不一致".into());
    }
    Ok(graph)
}

fn tag_ids<'a>(layout: &'a Layout, key: &str) -> Vec<&'a str> {
    layout
        .tags
        .assigned(key)
        .into_iter()
        .flatten()
        .map(String::as_str)
        .take(24)
        .collect()
}

fn flow_index(board: &BoardFile, node: &storage::BoardNode) -> Option<usize> {
    let owner = node.extra.get("flowOwnerId")?.as_str()?;
    board
        .nodes
        .iter()
        .find(|n| n.id == owner)?
        .extra
        .get("flow")?
        .get("nodeIds")?
        .as_array()?
        .iter()
        .position(|id| id.as_str() == Some(&node.id))
}

fn read_covers(root: &Path, revisions: &mut Revisions) -> Result<covers::CoverStore, String> {
    Ok(draft::observe(root, revisions, covers::FILE)?
        .map(|bytes| covers::parse(&bytes))
        .transpose()?
        .unwrap_or_default())
}

fn question_path(id: &str) -> String {
    format!("docs/question_{id}.md")
}

fn doc_info(doc: &DocRef) -> Value {
    let kind = if doc.path.starts_with("docs/sticker_") {
        "image"
    } else if doc.path.ends_with(".md") || doc.path.ends_with(".markdown") {
        "markdown_or_attachment"
    } else {
        "attachment"
    };
    json!({"documentId":draft::resources::doc_id(&doc.path),"title":part(&doc.title,200),"bytes":doc.bytes,"kind":kind})
}

fn part(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn matches_name(value: &str, query: &Option<String>) -> bool {
    query
        .as_deref()
        .is_none_or(|q| value.to_lowercase().contains(&q.trim().to_lowercase()))
}

fn text_page(body: &str, offset: usize, length: usize) -> Value {
    let mut chars = body.chars().skip(offset);
    let text: String = chars.by_ref().take(length).collect();
    json!({"markdown":text,"offset":offset,"nextOffset":chars.next().map(|_|offset + length)})
}

fn page<T>(rows: &[T], offset: Option<usize>, serialize: impl FnMut(&T) -> Value) -> Value {
    let offset = offset.unwrap_or(0).min(rows.len());
    let next = (offset + PAGE_SIZE).min(rows.len());
    json!({"rows": rows[offset..next].iter().map(serialize).collect::<Vec<_>>(),
        "total":rows.len(),"nextOffset":(next < rows.len()).then_some(next)})
}

#[tauri::command]
pub fn workspace_ai_read(
    query: Query,
    share_board_contents: bool,
    expected_scope: String,
) -> Result<View, String> {
    let _io = sync::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let root = commands::root()?;
    board_operations::ensure_scope(&root, &expected_scope)?;
    sync::recover(&root)?;
    read_at(&root, query, share_board_contents)
}
