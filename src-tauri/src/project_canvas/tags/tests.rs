use super::*;
use crate::project_canvas::{tests::Library, FILE};
use std::fs;

#[test]
fn labels_on_folders_boards_and_nodes_persist_without_changing_originals() {
    let library = Library::new();
    let root = &library.0;
    let project = storage::create_project(root, "理论").unwrap();
    let board = storage::create_board(root, &project.id, "应用").unwrap();
    let mut original = storage::load_board(root, &project.id, &board.id).unwrap();
    let node: storage::BoardNode = serde_json::from_value(serde_json::json!({
        "id":"n_1","title":"公式","x":15,"y":12,"created_at":"2026-11-18","updated_at":"2026-11-18"
    }))
    .unwrap();
    original.nodes.push(node);
    storage::save_board(root, &original).unwrap();
    let board_path = storage::board_file(root, &project.id, &board.id);
    let board_before = fs::read(&board_path).unwrap();
    let named = TagDefinition {
        name: "要复核".into(),
        color: "#956bc2".into(),
    };
    let project_target = TagTarget::Project {
        id: project.id.clone(),
    };
    let board_target = TagTarget::Board {
        project_id: project.id.clone(),
        id: board.id.clone(),
    };
    let node_target = TagTarget::Node {
        project_id: project.id.clone(),
        board_id: board.id.clone(),
        id: "n_1".into(),
    };
    let ids = BTreeSet::from(["color_green".into(), "tag_review".into()]);
    assign(
        root,
        &project_target,
        ids.clone(),
        BTreeMap::from([("tag_review".into(), named.clone())]),
    )
    .unwrap();
    assign(root, &board_target, ids.clone(), BTreeMap::new()).unwrap();
    let result = assign(root, &node_target, ids.clone(), BTreeMap::new()).unwrap();
    assert_eq!(result.tags.assignments.len(), 3);
    assert!(result.tags.assignments.values().all(|set| set == &ids));
    assert_eq!(
        read(root, &storage::read_index(root).unwrap()).unwrap(),
        result
    );
    assert_eq!(fs::read(&board_path).unwrap(), board_before);
    let result = assign(root, &node_target, BTreeSet::new(), BTreeMap::new()).unwrap();
    assert_eq!(result.tags.assignments.len(), 2);
    assert_eq!(result.tags.definitions["tag_review"], named);
}

#[test]
fn invalid_ownership_undefined_tags_and_duplicate_names_leave_layout_intact() {
    let library = Library::new();
    let root = &library.0;
    let project = storage::create_project(root, "理论").unwrap();
    let target = TagTarget::Project {
        id: project.id.clone(),
    };
    assign(
        root,
        &target,
        BTreeSet::from(["color_red".into()]),
        BTreeMap::new(),
    )
    .unwrap();
    let before = fs::read(root.join(FILE)).unwrap();
    assert!(assign(
        root,
        &target,
        BTreeSet::from(["tag_missing".into()]),
        BTreeMap::new()
    )
    .is_err());
    let duplicate = TagDefinition {
        name: "红色".into(),
        color: "#dd3333".into(),
    };
    assert!(assign(
        root,
        &target,
        BTreeSet::new(),
        BTreeMap::from([("tag_duplicate".into(), duplicate)])
    )
    .is_err());
    let wrong = TagTarget::Node {
        project_id: project.id,
        board_id: "missing_board".into(),
        id: "missing_node".into(),
    };
    assert!(assign(
        root,
        &wrong,
        BTreeSet::from(["color_blue".into()]),
        BTreeMap::new()
    )
    .is_err());
    assert_eq!(fs::read(root.join(FILE)).unwrap(), before);
}
