use super::*;
use crate::project_canvas::{self, covers};
use serde_json::json;
use std::path::PathBuf;

struct Library(PathBuf);

impl Library {
    fn new() -> Self {
        let root = std::env::temp_dir().join(storage::new_id("workspace_ai_test"));
        storage::ensure_storage(&root).unwrap();
        Self(root)
    }
    fn read(&self, path: &str) -> Vec<u8> {
        fs::read(self.0.join(path)).unwrap()
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn stage(lib: &Library, operations: Value) -> Result<Prepared, String> {
    prepare_at(
        &lib.0,
        json!({"schema":operations::SCHEMA,"operations":operations}),
    )
}

#[test]
fn previews_nested_project_board_graph_tags_cover_and_flow_and_undo_restores_original() {
    let lib = Library::new();
    let folder = storage::create_project(&lib.0, "数理研究").unwrap();
    let parent = lib.read(&format!("{}/project.json", folder.id));
    let before = lib.read("index.json");
    let board = json!({"projectId":"@study","boardId":"@board"});
    let prepared = stage(&lib, json!([
        {"op":"create_project","key":"@study","name":"方程讲义","parentId":folder.id},
        {"op":"create_project","key":"@papers","name":"论文","parentId":folder.id},
        {"op":"project_link","from":"@study","to":"@papers","label":"应用到 $\\nu$"},
        {"op":"create_board","key":"@board","projectId":"@study","name":"求解路径"},
        {"op":"update_board","board":board,"appearance":{"fontFamily":"serif","fontSize":19,"zoomSensitivity":1.25}},
        {"op":"create_node","key":"@topic","board":board,"fields":{"title":"线性方程","color":"#3a9d5d","summary":"# 题目\n\n$\\nu x = f$"}},
        {"op":"create_node","key":"@branch","board":board,"fields":{"title":"代入检验","position":{"x":120,"y":460},"width":320}},
        {"op":"connect_nodes","board":board,"from":"@topic","to":"@branch","label":"检验 $x$","route":{"kind":"bent","control":{"x":240,"y":320}}},
        {"op":"create_node","key":"@step1","board":board,"fields":{"title":"分离系数"}},
        {"op":"create_node","key":"@step2","board":board,"fields":{"title":"求解"}},
        {"op":"set_flow","board":board,"ownerId":"@branch","stepIds":["@step1","@step2"]},
        {"op":"add_markdown","board":board,"nodeId":"@step2","title":"推导","markdown":"## 解\n\n$x=f/\\nu$"},
        {"op":"create_tag","key":"@derived","name":"推导","color":"#21ac69"},
        {"op":"assign_tags","target":{"kind":"node","board":board,"nodeId":"@step2"},"add":["@derived","color_green"]},
        {"op":"set_cover","target":{"kind":"project","projectId":"@study"},"coverId":"celadon-line"},
        {"op":"set_pinned","target":{"kind":"board","board":board},"pinned":true}
    ])).unwrap();
    assert_eq!(lib.read("index.json"), before);
    assert!(!lib.0.join(project_canvas::FILE).exists());
    assert!(latest_at(&lib.0).unwrap().is_none());
    assert_eq!(prepared.plan.changes.len(), 16);
    let applied = commit_at(&lib.0, &prepared).unwrap();
    let work = &applied.destinations[0];
    let bid = applied.destinations[2].board_id.as_deref().unwrap();
    let layout = project_canvas::read(&lib.0, &storage::read_index(&lib.0).unwrap()).unwrap();
    assert_eq!(layout.parent(&work.project_id), Some(folder.id.as_str()));
    assert_eq!(
        layout.relations()[0].label.as_deref(),
        Some("应用到 $\\nu$")
    );
    assert_eq!(layout.pins[&format!("{}/{bid}", work.project_id)], true);
    let mut board = storage::load_board(&lib.0, &work.project_id, bid).unwrap();
    assert_eq!(board.name, "求解路径");
    assert_eq!(board.extra["appearance"]["zoomSensitivity"], 1.25);
    assert_eq!(board.nodes.len(), 4);
    assert_eq!(board.edges.len(), 2);
    assert_eq!(board.edges[0].extra["route"]["kind"], "bent");
    assert_eq!(
        board.nodes[1].extra["flow"]["nodeIds"],
        json!([board.nodes[2].id, board.nodes[3].id])
    );
    assert_eq!(board.edges[1].from, board.nodes[2].id);
    assert_eq!(board.edges[1].to, board.nodes[3].id);
    assert_eq!(board.nodes[2].extra["flowOwnerId"], board.nodes[1].id);
    let body_path = board.nodes[0].docs[0].path.as_str();
    assert_eq!(
        documents::read_payload(&lib.0, &work.project_id, bid, body_path)
            .unwrap()
            .markdown,
        "# 题目\n\n$\\nu x = f$"
    );
    assert!(layout
        .tags
        .assigned(&format!("{}/{bid}/{}", work.project_id, board.nodes[3].id))
        .unwrap()
        .contains("color_green"));
    assert_eq!(
        covers::read(&lib.0).unwrap()[&work.project_id],
        "celadon-line"
    );
    let query = serde_json::from_value(
        json!({"kind":"nodes","board":{"projectId":work.project_id,"boardId":bid}}),
    )
    .unwrap();
    assert!(read::read_at(&lib.0, query, false).is_err());
    assert_eq!(latest_at(&lib.0).unwrap().unwrap().id, applied.id);
    board.viewport.x += 123.0;
    storage::save_board(&lib.0, &board).unwrap();
    undo_at(&lib.0, &applied.id).unwrap();
    assert_eq!(lib.read("index.json"), before);
    assert_eq!(lib.read(&format!("{}/project.json", folder.id)), parent);
    assert!(!lib.0.join(&work.project_id).exists());
    assert!(!lib.0.join(covers::FILE).exists());
    assert!(!lib.0.join(project_canvas::FILE).exists());
    assert!(latest_at(&lib.0).unwrap().is_none());
}

#[test]
fn markdown_revisions_original_and_cross_board_images_survive_batch_and_undo() {
    let lib = Library::new();
    let project = storage::create_project(&lib.0, "合成项目").unwrap();
    let b = storage::create_board(&lib.0, &project.id, "合成白板").unwrap();
    let initial = json!({"projectId":project.id,"boardId":b.id});
    let first = stage(&lib, json!([
        {"op":"create_node","key":"@n","board":initial,"fields":{"title":"旧标题","summary":"旧问题"}},
        {"op":"add_markdown","board":initial,"nodeId":"@n","title":"原文","markdown":"旧正文\r\n"}
    ])).unwrap();
    let first = commit_at(&lib.0, &first).unwrap();
    let mut original = storage::load_board(&lib.0, &project.id, &b.id).unwrap();
    let mark = original.nodes[0].docs[0].clone();
    let base = format!("{}/{}", project.id, b.id);
    let image = documents::prepare_image(
        STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA+wAAAAASUVORK5CYII=").unwrap(),
        "合成图".into(),
    ).unwrap();
    for (path, bytes) in image.files {
        sync::atomic_bytes(&lib.0.join(format!("{base}/{path}")), &bytes).unwrap();
    }
    let image_id = draft::resources::doc_id(&image.reference.path);
    original.nodes[0].docs.push(image.reference);
    storage::save_board(&lib.0, &original).unwrap();
    let original_board = lib.read(&format!("{base}/board.json"));
    let original_doc = lib.read(&format!("{base}/{}", mark.path));
    let id = &original.nodes[0].id;
    let target = json!({"projectId":project.id,"boardId":"@copy"});
    let mut prepared = stage(&lib, json!([
        {"op":"update_node","board":initial,"nodeId":id,"fields":{"title":"新标题","summary":"新问题"}},
        {"op":"edit_markdown","board":initial,"nodeId":id,"documentId":draft::resources::doc_id(&mark.path),"revision":documents::hash(&original_doc),"markdown":"新正文"},
        {"op":"create_board","key":"@copy","projectId":project.id,"name":"复用图片"},
        {"op":"create_node","key":"@image","board":target,"fields":{}},
        {"op":"attach_document","board":target,"sourceBoard":initial,"fromNodeId":id,"toNodeId":"@image","documentId":image_id},
        {"op":"arrange_nodes","board":target,"nodeIds":["@image"],"direction":"down","spacing":"airy","reason":"留出阅读图片的空间"}
    ])).unwrap();
    let job = &prepared.plan.layout_jobs[0];
    let image_source = job.documents.values().next().unwrap().source.as_ref().unwrap();
    assert_eq!(image_source.board_id, b.id);
    let measured = measured_layout(job, json!({"x":120,"y":120,"w":280,"h":280}));
    super::layout::place(&lib.0, &mut prepared, vec![measured]).unwrap();
    let changed = commit_at(&lib.0, &prepared).unwrap();
    let new_id = changed.destinations[0].board_id.as_deref().unwrap();
    let new = storage::load_board(&lib.0, &project.id, new_id).unwrap();
    assert!(new.nodes[0].title.is_empty());
    let raw = lib.read(&format!(
        "{}/{}/{}",
        project.id, new_id, new.nodes[0].docs[0].path
    ));
    let image_assets = documents::dependencies(&raw).unwrap();
    assert!(!image_assets.is_empty());
    documents::verified_asset(&lib.0, &project.id, new_id, &image_assets[0]).unwrap();
    let history = format!(
        "{base}/.document-history/{}/original.md",
        documents::hash(mark.path.as_bytes())
    );
    assert_eq!(lib.read(&history), original_doc);
    assert_eq!(
        lib.read(&format!("{base}/{}", mark.path)),
        "新正文".as_bytes()
    );
    undo_at(&lib.0, &changed.id).unwrap();
    assert_eq!(lib.read(&format!("{base}/board.json")), original_board);
    assert_eq!(lib.read(&format!("{base}/{}", mark.path)), original_doc);
    assert_eq!(latest_at(&lib.0).unwrap().unwrap().id, first.id);
    assert!(!lib
        .0
        .join(format!("{}/{new_id}/board.json", project.id))
        .exists());
}

fn measured_layout(job: &super::layout::LayoutJob, bounds: Value) -> super::layout::MeasuredLayout {
    let nodes: serde_json::Map<_, _> = job.nodes.iter().map(|node| (node.id.clone(), bounds.clone())).collect();
    serde_json::from_value(json!({"projectId":job.project_id,"boardId":job.board_id,"nodes":nodes})).unwrap()
}

#[test]
fn measured_workspace_arrangement_is_required_before_apply_and_undo_restores_positions() {
    let lib = Library::new();
    let p = storage::create_project(&lib.0, "布局验收").unwrap();
    let b = storage::create_board(&lib.0, &p.id, "合成题目").unwrap();
    let board = json!({"projectId":p.id,"boardId":b.id});
    let original = stage(&lib, json!([
        {"op":"create_node","key":"@old","board":board,"fields":{"title":"原位置","position":{"x":0,"y":0},"height":100}},
    ])).unwrap();
    commit_at(&lib.0, &original).unwrap();
    let board_path = format!("{}/{}/board.json", p.id, b.id);
    let original_bytes = lib.read(&board_path);
    let mut prepared = stage(&lib, json!([
        {"op":"create_node","key":"@root","board":board,"fields":{"title":"=={#FFF146}核心==","color":"#345FA8"}},
        {"op":"create_node","key":"@step","board":board,"fields":{"title":"分支"}},
        {"op":"add_markdown","board":board,"nodeId":"@step","title":"公式","markdown":"$x^2+y^2$"},
        {"op":"connect_nodes","board":board,"from":"@root","to":"@step"},
        {"op":"arrange_nodes","board":board,"nodeIds":["@root","@step"],"direction":"right","spacing":"balanced","reason":"先核心再看证据"},
    ])).unwrap();
    assert!(commit_at(&lib.0, &prepared).is_err());
    assert_eq!(lib.read(&board_path), original_bytes);
    let job = &prepared.plan.layout_jobs[0];
    assert_eq!(job.nodes.len(), 2);
    assert_eq!(job.documents.values().next().unwrap().markdown, "$x^2+y^2$");
    let overlapping = measured_layout(job, json!({"x":500,"y":40,"w":260,"h":75}));
    assert!(super::layout::place(&lib.0, &mut prepared, vec![overlapping]).is_err());
    let job = &prepared.plan.layout_jobs[0];
    let id = job.nodes[0].id.clone();
    let nodes = json!({ (id.clone()): {"x":500,"y":40,"w":260,"h":75}, (job.nodes[1].id.clone()): {"x":870,"y":40,"w":410,"h":217} });
    let measured = serde_json::from_value(json!({"projectId":p.id,"boardId":b.id,"nodes":nodes})).unwrap();
    super::layout::place(&lib.0, &mut prepared, vec![measured]).unwrap();
    assert_eq!(prepared.plan.layouts.len(), 1);
    assert_eq!(lib.read(&board_path), original_bytes);
    let applied = commit_at(&lib.0, &prepared).unwrap();
    let state = storage::load_board(&lib.0, &p.id, &b.id).unwrap();
    assert_eq!(state.nodes[0].x, 0.0);
    assert_eq!(state.nodes[0].y, 0.0);
    let root = state.nodes.iter().find(|node| node.id == id).unwrap();
    assert_eq!((root.x, root.y, root.w), (500.0, 40.0, 260.0));
    assert_eq!(root.color.as_deref(), Some("#345FA8"));
    assert_eq!(root.title, "=={#FFF146}核心==");
    undo_at(&lib.0, &applied.id).unwrap();
    assert_eq!(lib.read(&board_path), original_bytes);
}

#[test]
fn invalid_batches_and_stale_preview_leave_original_bytes_intact() {
    let lib = Library::new();
    let p = storage::create_project(&lib.0, "原项目").unwrap();
    let before = lib.read("index.json");
    for invalid in [
        json!([{"op":"create_project","key":"@new","name":"不应创建"},{"op":"move_project","projectId":"@new","parentId":"@new"}]),
        json!([{"op":"move_project","projectId":p.id}]),
        json!([{"op":"remove_project","projectId":"../escape"}]),
        json!([{"op":"create_project","key":"@new","name":"不应创建","extra":"invalid"}]),
        json!([{"op":"create_board","key":"@b","name":"无项目","projectId":"@missing"}]),
    ] {
        assert!(stage(&lib, invalid).is_err());
        assert_eq!(lib.read("index.json"), before);
    }
    let draft = stage(
        &lib,
        json!([{"op":"rename_project","projectId":p.id,"name":"计划改名"}]),
    )
    .unwrap();
    storage::rename_project(&lib.0, &p.id, "用户稍后手动改名").unwrap();
    let newer = lib.read("index.json");
    assert!(commit_at(&lib.0, &draft).is_err());
    assert_eq!(lib.read("index.json"), newer);
    assert!(latest_at(&lib.0).unwrap().is_none());
}

#[test]
fn removal_preserves_board_and_undo_checks_later_edits() {
    let lib = Library::new();
    let parent = storage::create_project(&lib.0, "父项目").unwrap();
    let child = project_canvas::create_child(&lib.0, "子项目", &parent.id).unwrap();
    let b = storage::create_board(&lib.0, &child.id, "原白板").unwrap();
    let path = format!("{}/{}/board.json", child.id, b.id);
    let original_board = lib.read(&path);
    assert!(stage(&lib, json!([{"op":"remove_project","projectId":parent.id}])).is_err());
    let before = lib.read("index.json");
    let layout = lib.read(project_canvas::FILE);
    let draft = stage(
        &lib,
        json!([{"op":"remove_project","projectId":parent.id,"includeChildren":true}]),
    )
    .unwrap();
    let receipt = commit_at(&lib.0, &draft).unwrap();
    assert!(storage::read_index(&lib.0).unwrap().projects.is_empty());
    assert_eq!(lib.read(&path), original_board);
    undo_at(&lib.0, &receipt.id).unwrap();
    assert_eq!(lib.read("index.json"), before);
    assert_eq!(lib.read(project_canvas::FILE), layout);
    let draft = stage(&lib, json!([{"op":"update_board","board":{"projectId":child.id,"boardId":b.id},"name":"测试重命名"}])).unwrap();
    let receipt = commit_at(&lib.0, &draft).unwrap();
    let mut edited = storage::load_board(&lib.0, &child.id, &b.id).unwrap();
    edited.viewport.x = 80.0;
    storage::save_board(&lib.0, &edited).unwrap();
    undo_at(&lib.0, &receipt.id).unwrap();
    let restored = storage::load_board(&lib.0, &child.id, &b.id).unwrap();
    assert_eq!(restored.name, "原白板");
    assert_eq!(restored.viewport.x, 80.0);
    let draft = stage(&lib, json!([{"op":"update_board","board":{"projectId":child.id,"boardId":b.id},"name":"再次重命名"}])).unwrap();
    let receipt = commit_at(&lib.0, &draft).unwrap();
    let mut edited = storage::load_board(&lib.0, &child.id, &b.id).unwrap();
    edited
        .extra
        .insert("appearance".into(), json!({"fontSize":22}));
    storage::save_board(&lib.0, &edited).unwrap();
    let edited = lib.read(&path);
    assert!(undo_at(&lib.0, &receipt.id).is_err());
    assert_eq!(lib.read(&path), edited);
}

#[test]
fn native_transaction_reverts_created_files_and_removals_together() {
    let lib = Library::new();
    let source = lib.read("index.json");
    fs::write(lib.0.join("z-file"), "already a regular file").unwrap();
    let changes = BTreeMap::from([
        ("a-new".into(), Some(vec![1])),
        ("index.json".into(), None),
        ("z-file/impossible".into(), Some(vec![2])),
    ]);
    assert!(sync::transaction_changes(&lib.0, changes).is_err());
    assert_eq!(lib.read("index.json"), source);
    assert!(!lib.0.join("a-new").exists());
    assert_eq!(lib.read("z-file"), b"already a regular file");
}
