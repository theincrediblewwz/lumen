use crate::{documents, library_package::*, portable_documents, storage};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
fn setup() -> (PathBuf, String, String) {
    let root = std::env::temp_dir().join(storage::new_id("library_package_test"));
    storage::ensure_storage(&root).unwrap();
    let p = storage::create_project(&root, "Project one").unwrap();
    let b = storage::create_board(&root, &p.id, "Board").unwrap();
    (root, p.id, b.id)
}

#[test]
fn project_package_keeps_its_nested_subtree_positions_and_materials() {
    let (root, parent, _) = setup();
    let child = crate::project_canvas::create_child(&root, "Nested project", &parent).unwrap();
    let grandchild = crate::project_canvas::create_child(&root, "Grandchild", &child.id).unwrap();
    let other =
        crate::project_canvas::create_child(&root, "Folder outside the subtree", &parent).unwrap();
    let sibling = crate::project_canvas::create_child(&root, "Related folder", &child.id).unwrap();
    let board = storage::create_board(&root, &grandchild.id, "Nested board").unwrap();
    let doc = storage::write_doc(
        &root,
        &grandchild.id,
        &board.id,
        "Nested original",
        "Original text",
    )
    .unwrap();
    let layout_path = root.join(crate::project_canvas::FILE);
    let mut raw: Value = serde_json::from_slice(&fs::read(&layout_path).unwrap()).unwrap();
    raw["projects"][&child.id]["position"] = json!({ "x":135.5, "y":-42.0 });
    raw["boards"][&grandchild.id][&board.id] = json!({ "x":70, "y":320 });
    let complete_edge = json!({ "from": &grandchild.id, "to": &sibling.id });
    raw["relations"] = json!([complete_edge.clone(), { "from": &child.id, "to": &other.id }]);
    let original_layout = serde_json::to_vec(&raw).unwrap();
    fs::write(&layout_path, &original_layout).unwrap();
    let restores = root.with_extension("canvas-restores");
    fs::create_dir(&restores).unwrap();
    let archive = restores.join("nested.zip");
    let result = export_at(&root, Some(&child.id), &archive, json!({}), |_, _| {}).unwrap();
    assert_eq!(result["projects"], 3);
    let restored = restore_at(&archive, &restores).unwrap();
    let destination = PathBuf::from(restored["root"].as_str().unwrap());
    let index = storage::read_index(&destination).unwrap();
    let layout = crate::project_canvas::read(&destination, &index).unwrap();
    assert_eq!(layout.parent(&child.id), None);
    assert_eq!(layout.parent(&grandchild.id), Some(child.id.as_str()));
    assert!(!destination.join(&other.id).exists());
    let restored_layout: Value =
        serde_json::from_slice(&fs::read(destination.join(crate::project_canvas::FILE)).unwrap())
            .unwrap();
    assert_eq!(
        restored_layout["projects"][&child.id]["position"],
        raw["projects"][&child.id]["position"]
    );
    assert_eq!(
        restored_layout["boards"][&grandchild.id][&board.id]["y"].as_f64(),
        Some(320.0)
    );
    assert_eq!(restored_layout["relations"], json!([complete_edge]));
    let relative = PathBuf::from(grandchild.id).join(board.id).join(doc.path);
    assert_eq!(
        fs::read(destination.join(&relative)).unwrap(),
        fs::read(root.join(relative)).unwrap()
    );
    assert_eq!(fs::read(layout_path).unwrap(), original_layout);
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(restores).unwrap();
}
fn library(board: &str) -> Value {
    let now = storage::now_iso();
    let entry = |id: &str| json!({"id":id,"kind":"understanding","title":id,"body":"Personal understanding","source":"Synthetic","authorship":"user","basis_json":"[]","created_at":now,"updated_at":now,"revision_id":format!("rev_{id}"),"archived":0});
    let entries = vec![entry("referenced"), entry("independent")];
    let revisions = entries
        .iter()
        .map(|e| {
            let mut r = e.clone();
            r["entry_id"] = e["id"].clone();
            r["id"] = e["revision_id"].clone();
            r.as_object_mut().unwrap().remove("revision_id");
            r
        })
        .collect::<Vec<_>>();
    json!({"version":1,"entries":entries,"revisions":revisions,"bindings":[{"id":"binding","entry_id":"referenced","project_id":board,"node_id":null,"created_at":now}],"settings":[]})
}
#[test]
fn whole_library_roundtrip_includes_projects_independent_knowledge_history_originals_and_preferences(
) {
    let (root, p, b) = setup();
    let parent = root.with_extension("restores");
    fs::create_dir(&parent).unwrap();
    let p2 = storage::create_project(&root, "Project two").unwrap();
    storage::create_board(&root, &p2.id, "Second").unwrap();
    let base = storage::board_dir(&root, &p, &b);
    fs::write(base.join("docs/orphan.md"), b"# Original $x_i$").unwrap();
    for folder in [".ai-backups", ".snapshots", ".chat-trash"] {
        fs::create_dir(base.join(folder)).unwrap();
        fs::write(base.join(folder).join("synthetic.json"), b"{\"files\":{}}").unwrap();
    }
    fs::create_dir(root.join("knowledge")).unwrap();
    let mut original_library = library(&b);
    original_library["bindings"].as_array_mut().unwrap().push(json!({"id":"historical_binding","entry_id":"independent","project_id":"deleted_board","node_id":null,"created_at":storage::now_iso()}));
    let knowledge = serde_json::to_vec(&original_library).unwrap();
    fs::write(root.join("knowledge/library.json"), &knowledge).unwrap();
    fs::create_dir(root.join("credentials-local")).unwrap();
    fs::write(
        root.join("credentials-local/vault.json"),
        b"synthetic credential excluded",
    )
    .unwrap();
    fs::create_dir_all(root.join(".lumen-sync")).unwrap();
    fs::write(
        root.join(".lumen-sync/settings.json"),
        b"synthetic connection excluded",
    )
    .unwrap();
    let archive = parent.join("whole.zip");
    let before = fs::read(root.join("index.json")).unwrap();
    let preferences = json!({"progress":{"synthetic/document":0.75},"ui":{"theme":"paper"}});
    let result = export_at(&root, None, &archive, preferences.clone(), |_, _| {}).unwrap();
    assert_eq!(result["projects"], 2);
    let restored = restore_at(&archive, &parent).unwrap();
    let target = PathBuf::from(restored["root"].as_str().unwrap());
    assert_eq!(fs::read(target.join("index.json")).unwrap(), before);
    assert_eq!(
        fs::read(target.join("knowledge/library.json")).unwrap(),
        knowledge
    );
    assert_eq!(restored["preferences"], preferences);
    assert_eq!(
        fs::read(target.join(&p).join(&b).join("docs/orphan.md")).unwrap(),
        b"# Original $x_i$"
    );
    for folder in [".ai-backups", ".snapshots", ".chat-trash"] {
        assert!(target
            .join(&p)
            .join(&b)
            .join(folder)
            .join("synthetic.json")
            .is_file());
    }
    assert!(!target.join("credentials-local").exists());
    assert!(!target.join(".lumen-sync").exists());
    assert_eq!(fs::read(root.join("index.json")).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(parent).unwrap();
}
#[test]
fn project_scope_keeps_knowledge_dependencies_but_excludes_other_projects_and_unrelated_knowledge()
{
    let (root, p, b) = setup();
    let parent = root.with_extension("restores");
    fs::create_dir(&parent).unwrap();
    let p2 = storage::create_project(&root, "Other").unwrap();
    storage::create_board(&root, &p2.id, "Other").unwrap();
    fs::create_dir(root.join("knowledge")).unwrap();
    fs::write(
        root.join("knowledge/library.json"),
        serde_json::to_vec(&library(&b)).unwrap(),
    )
    .unwrap();
    let archive = parent.join("project.zip");
    export_at(&root, Some(&p), &archive, Value::Null, |_, _| {}).unwrap();
    let restored = restore_at(&archive, &parent).unwrap();
    let target = PathBuf::from(restored["root"].as_str().unwrap());
    let index = storage::read_index(&target).unwrap();
    assert_eq!(index.projects.len(), 1);
    assert_eq!(index.projects[0].id, p);
    assert!(!target.join(p2.id).exists());
    let knowledge: Value =
        serde_json::from_slice(&fs::read(target.join("knowledge/library.json")).unwrap()).unwrap();
    assert_eq!(knowledge["entries"].as_array().unwrap().len(), 1);
    assert_eq!(knowledge["entries"][0]["id"], "referenced");
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(parent).unwrap();
}
#[test]
fn tampering_and_traversal_fail_without_leaving_a_restored_library_or_changing_source() {
    let (root, p, b) = setup();
    let parent = root.with_extension("restores");
    fs::create_dir(&parent).unwrap();
    let archive = parent.join("valid.zip");
    export_at(&root, None, &archive, Value::Null, |_, _| {}).unwrap();
    let mut files =
        documents::unzip_limit(&fs::read(&archive).unwrap(), 16 * 1024 * 1024, 200).unwrap();
    files.insert(format!("data/{p}/{b}/board.json"), b"{}".to_vec());
    let damaged = parent.join("damaged.zip");
    fs::write(&damaged, portable_documents::archive(&files).unwrap()).unwrap();
    assert!(restore_at(&damaged, &parent).is_err());
    assert_eq!(
        fs::read_dir(&parent)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().unwrap().is_dir())
            .count(),
        0
    );
    assert!(storage::load_board(&root, &p, &b).is_ok());
    files.insert("data/../escape".into(), vec![0]);
    fs::write(&damaged, portable_documents::archive(&files).unwrap()).unwrap();
    assert!(restore_at(&damaged, &parent).is_err());
    assert!(!parent.join("escape").exists());
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(parent).unwrap();
}
#[test]
fn streaming_archive_handles_more_than_the_old_96_mib_board_package_budget() {
    let (root, p, b) = setup();
    let parent = root.with_extension("restores");
    fs::create_dir(&parent).unwrap();
    let source = storage::docs_dir(&root, &p, &b).join("large-original.pdf");
    fs::File::create(&source)
        .unwrap()
        .set_len(100 * 1024 * 1024)
        .unwrap();
    let archive = parent.join("large.zip");
    let result = export_at(&root, None, &archive, Value::Null, |_, _| {}).unwrap();
    assert!(result["bytes"].as_u64().unwrap() > 96 * 1024 * 1024);
    let restored = restore_at(&archive, &parent).unwrap();
    assert_eq!(
        fs::metadata(
            PathBuf::from(restored["root"].as_str().unwrap())
                .join(&p)
                .join(&b)
                .join("docs/large-original.pdf")
        )
        .unwrap()
        .len(),
        100 * 1024 * 1024
    );
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(parent).unwrap();
}
#[test]
fn project_keeps_knowledge_referenced_only_by_historical_markdown_byte_arrays() {
    let (root, p, b) = setup();
    let parent = root.with_extension("restores");
    fs::create_dir(&parent).unwrap();
    fs::create_dir(root.join("knowledge")).unwrap();
    fs::write(
        root.join("knowledge/library.json"),
        serde_json::to_vec(&library(&b)).unwrap(),
    )
    .unwrap();
    let dir = storage::board_dir(&root, &p, &b).join(".ai-backups");
    fs::create_dir(&dir).unwrap();
    let raw = b"[Historical understanding](learnstuff-knowledge://independent/rev_independent)";
    fs::write(dir.join("version.json"),serde_json::to_vec(&json!({"schema":"lumen.board-backup/v2","files":{"docs/history.md":raw.to_vec(),"docs/asset_ignored.pdf":"skipped binary original"}})).unwrap()).unwrap();
    let archive = parent.join("project.zip");
    export_at(&root, Some(&p), &archive, Value::Null, |_, _| {}).unwrap();
    let restored = restore_at(&archive, &parent).unwrap();
    let target = PathBuf::from(restored["root"].as_str().unwrap());
    let value: Value =
        serde_json::from_slice(&fs::read(target.join("knowledge/library.json")).unwrap()).unwrap();
    assert_eq!(value["entries"].as_array().unwrap().len(), 2);
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(parent).unwrap();
}
#[test]
fn original_hashes_survive_roundtrip_and_failed_export_keeps_an_existing_archive() {
    let (root, p, b) = setup();
    let parent = root.with_extension("restores");
    fs::create_dir(&parent).unwrap();
    let bytes = b"%PDF-1.7\nsynthetic original\n%%EOF";
    let hash = documents::hash(bytes);
    let relative = format!("docs/asset_{hash}.pdf");
    let docs = storage::docs_dir(&root, &p, &b);
    fs::write(storage::board_dir(&root, &p, &b).join(&relative), bytes).unwrap();
    let metadata = json!({"schema":"lumen-document/v1","kind":"pdf","original":{"path":relative,"sha256":hash,"size":bytes.len(),"media_type":"application/pdf"},"images":{},"pages":1,"extraction":"ready"});
    fs::write(
        docs.join("mounted.md"),
        format!(
            "<!-- lumen-document/v1\n{}\n-->\n\n# Extracted text",
            metadata
        ),
    )
    .unwrap();
    let archive = parent.join("whole.zip");
    export_at(&root, None, &archive, Value::Null, |_, _| {}).unwrap();
    let before = fs::read(&archive).unwrap();
    let restored = restore_at(&archive, &parent).unwrap();
    let target = PathBuf::from(restored["root"].as_str().unwrap());
    assert_eq!(
        fs::read(target.join(&p).join(&b).join(&relative)).unwrap(),
        bytes
    );
    fs::remove_file(storage::board_dir(&root, &p, &b).join(relative)).unwrap();
    assert!(export_at(&root, None, &archive, Value::Null, |_, _| {}).is_err());
    assert_eq!(fs::read(&archive).unwrap(), before);
    assert!(!fs::read_dir(&parent)
        .unwrap()
        .filter_map(Result::ok)
        .any(|row| row.file_name().to_string_lossy().ends_with(".tmp")));
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(parent).unwrap();
}
