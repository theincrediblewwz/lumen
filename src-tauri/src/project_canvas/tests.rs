use super::*;

pub(super) struct Library(pub(super) std::path::PathBuf);

impl Library {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(storage::new_id("project_canvas_test"));
        storage::ensure_storage(&path).unwrap();
        Self(path)
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn old_projects_stay_at_root_and_moving_a_subtree_keeps_original_files() {
    let library = Library::new();
    let root = &library.0;
    let legacy = storage::create_project(root, "先前已有的项目").unwrap();
    let other = storage::create_project(root, "另一个项目").unwrap();
    let board = storage::create_board(root, &legacy.id, "旧白板").unwrap();
    let doc = storage::write_doc(root, &legacy.id, &board.id, "原文", "原文保留").unwrap();
    let board_file = storage::board_file(root, &legacy.id, &board.id);
    let doc_file = storage::board_dir(root, &legacy.id, &board.id).join(&doc.path);
    let original = [fs::read(&board_file).unwrap(), fs::read(&doc_file).unwrap()];
    let initial = read(root, &storage::read_index(root).unwrap()).unwrap();
    assert_eq!(initial.parent(&legacy.id), None);
    assert!(!root.join(FILE).exists());

    let child = create_child(root, "第二层", &legacy.id).unwrap();
    let grandchild = create_child(root, "第三层", &child.id).unwrap();
    let layout = place(
        root,
        TileKind::Board,
        &board.id,
        Some(&legacy.id),
        Position { x: 328.5, y: -64.0 },
    )
    .unwrap();
    assert_eq!(layout.parent(&grandchild.id), Some(child.id.as_str()));
    assert!(place(
        root,
        TileKind::Board,
        &board.id,
        None,
        Position { x: 1.0, y: 2.0 }
    )
    .is_err());
    let before = fs::read(root.join(FILE)).unwrap();
    assert!(move_project(root, &legacy.id, None, Some(grandchild.id.clone())).is_err());
    assert!(require_no_children(root, &legacy.id).is_err());
    assert_eq!(fs::read(root.join(FILE)).unwrap(), before);

    let moved = move_project(root, &legacy.id, None, Some(other.id.clone())).unwrap();
    assert_eq!(moved.parent(&legacy.id), Some(other.id.as_str()));
    assert_eq!(moved.parent(&child.id), Some(legacy.id.as_str()));
    assert_eq!(moved.boards[&legacy.id][&board.id].x, 328.5);
    assert!(move_project(root, &legacy.id, None, None).is_err());
    assert_eq!(
        read(root, &storage::read_index(root).unwrap()).unwrap(),
        moved
    );
    assert_eq!(
        [fs::read(board_file).unwrap(), fs::read(doc_file).unwrap()],
        original
    );
}

#[test]
fn sync_board_removal_leaves_folder_hierarchy_and_recoverable_board_files() {
    let library = Library::new();
    let root = &library.0;
    let parent = storage::create_project(root, "保留这个项目").unwrap();
    let child = create_child(root, "空子项目", &parent.id).unwrap();
    let board = storage::create_board(root, &parent.id, "被同步删除的白板").unwrap();
    let board_file = storage::board_file(root, &parent.id, &board.id);
    let original = fs::read(&board_file).unwrap();
    let layout = fs::read(root.join(FILE)).unwrap();
    let mut writes = BTreeMap::from([(
        "index.json".into(),
        br#"{"version":1,"projects":[]}"#.to_vec(),
    )]);
    preserve_folders(root, &mut writes).unwrap();
    sync::transaction(root, writes).unwrap();
    assert_eq!(storage::read_index(root).unwrap().projects.len(), 2);
    assert!(storage::read_project(root, &parent.id)
        .unwrap()
        .boards
        .is_empty());
    assert_eq!(
        read(root, &storage::read_index(root).unwrap())
            .unwrap()
            .parent(&child.id),
        Some(parent.id.as_str())
    );
    assert_eq!(fs::read(root.join(FILE)).unwrap(), layout);
    assert_eq!(fs::read(board_file).unwrap(), original);
}

#[test]
fn corrupt_layout_is_reported_without_overwriting_the_existing_file() {
    let library = Library::new();
    let root = &library.0;
    let one = storage::create_project(root, "项目").unwrap();
    let loop_data = serde_json::json!({
        "version": 1, "projects": { (&one.id): { "parentId": &one.id } }
    })
    .to_string();
    fs::write(root.join(FILE), &loop_data).unwrap();
    assert!(create_child(root, "不要添加", &one.id).is_err());
    assert!(place(
        root,
        TileKind::Project,
        &one.id,
        None,
        Position { x: 1.0, y: 2.0 }
    )
    .is_err());
    assert_eq!(storage::read_index(root).unwrap().projects.len(), 1);
    assert_eq!(fs::read_to_string(root.join(FILE)).unwrap(), loop_data);
}

#[test]
fn directed_relations_are_idempotent_and_keep_their_endpoints_when_folders_move() {
    let relate = |root: &Path, parent: Option<&str>, from, to, present| {
        let change = if present {
            RelationChange::Add
        } else {
            RelationChange::Remove
        };
        change_relation(root, parent, from, to, change)
    };
    let library = Library::new();
    let root = &library.0;
    let theory = storage::create_project(root, "理论").unwrap();
    let paper = storage::create_project(root, "论文").unwrap();
    let folder = storage::create_project(root, "另一个文件夹").unwrap();
    let edge = Relation {
        from: theory.id.clone(),
        to: paper.id.clone(),
        label: None,
    };
    let added = relate(root, None, theory.id.clone(), paper.id.clone(), true).unwrap();
    assert_eq!(added.relations, vec![edge.clone()]);
    assert_eq!(
        relate(root, None, theory.id.clone(), paper.id.clone(), true).unwrap(),
        added
    );
    let bytes = fs::read(root.join(FILE)).unwrap();
    assert!(relate(root, None, theory.id.clone(), theory.id.clone(), true).is_err());
    assert!(relate(root, None, theory.id.clone(), "missing".into(), true).is_err());
    assert_eq!(fs::read(root.join(FILE)).unwrap(), bytes);

    let label = r"应用到这篇论文 $\nu^2$";
    let named = change_relation(
        root,
        None,
        theory.id.clone(),
        paper.id.clone(),
        RelationChange::Label(relation_label(label).unwrap()),
    )
    .unwrap();
    assert_eq!(named.relations[0].label.as_deref(), Some(label));
    assert!(relation_label(&"a".repeat(241)).is_err());
    assert!(relation_label("两\n行").is_err());
    let moved = move_project(root, &paper.id, None, Some(folder.id.clone())).unwrap();
    assert_eq!(moved.relations, named.relations);
    assert!(relate(root, None, theory.id.clone(), paper.id.clone(), false).is_err());
    let theory_moved = move_project(root, &theory.id, None, Some(folder.id.clone())).unwrap();
    assert_eq!(theory_moved.relations, named.relations);
    let updated = relate(
        root,
        Some(&folder.id),
        paper.id.clone(),
        theory.id.clone(),
        true,
    )
    .unwrap();
    assert_eq!(updated.relations.len(), 2);
    let removed = relate(
        root,
        Some(&folder.id),
        paper.id.clone(),
        theory.id.clone(),
        false,
    )
    .unwrap();
    assert_eq!(removed.relations, named.relations);
    assert_eq!(
        read(root, &storage::read_index(root).unwrap()).unwrap(),
        removed
    );

    storage::delete_project(root, &paper.id).unwrap();
    assert!(read(root, &storage::read_index(root).unwrap())
        .unwrap()
        .relations
        .is_empty());
}
