use crate::{board_operations, documents::*, portable_documents, storage, sync};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
fn setup() -> (PathBuf, String, String) {
    let root = std::env::temp_dir().join(storage::new_id("rich_documents_test"));
    storage::ensure_storage(&root).unwrap();
    let p = storage::create_project(&root, "测试项目").unwrap();
    let b = storage::create_board(&root, &p.id, "测试白板").unwrap();
    let mut board = storage::load_board(&root, &p.id, &b.id).unwrap();
    let now = storage::now_iso();
    board.nodes.push(storage::BoardNode {
        id: "n1".into(),
        title: "n1".into(),
        summary: None,
        x: 0.,
        y: 0.,
        w: 240.,
        color: None,
        docs: vec![],
        created_at: now.clone(),
        updated_at: now,
    });
    storage::save_board(&root, &board).unwrap();
    (root, p.id, b.id)
}
fn png() -> Vec<u8> {
    let hex="89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6350ea38f31f0004bc02762da7ade00000000049454e44ae426082";
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}
fn bundle(root: &Path) -> PathBuf {
    let bytes=portable_documents::archive(&BTreeMap::from([("answer.md".into(),"# 图文原文\n\n![图](images/image-001.png)\n\n$$\\frac{1}{2}$$\n\n<table><tr><td><img src=\"images/image-001.png\"></td></tr></table>".as_bytes().to_vec()),("images/image-001.png".into(),png()),("EXPORT-NOTES.md".into(),b"export diagnostics".to_vec())])).unwrap();
    let path = root.join("Answer.zip");
    fs::write(&path, bytes).unwrap();
    path
}
fn attach(root: &Path, p: &str, b: &str, src: &Path) -> storage::BoardFile {
    let prepared = prepare(src, "", "", 0).unwrap();
    attach_at(
        root,
        p,
        b,
        "n1",
        &sync::board_revision(root, p, b).unwrap(),
        prepared,
        20,
    )
    .unwrap()
}
#[test]
fn exporter_shaped_bundle_keeps_originals_and_current_markdown_export() {
    let (root, p, b) = setup();
    let src = bundle(&root);
    let original = fs::read(&src).unwrap();
    let board = attach(&root, &p, &b, &src);
    let doc = &board.nodes[0].docs[0];
    let payload = read_payload(&root, &p, &b, &doc.path).unwrap();
    let meta = payload.attachment.unwrap();
    assert_eq!(meta.images.len(), 1);
    assert_eq!(
        verified_asset(&root, &p, &b, &meta.original).unwrap(),
        original
    );
    assert!(payload.markdown.contains("$$\\frac{1}{2}$$"));
    assert!(!payload.markdown.contains(PREFIX));
    assert_eq!(
        verified_asset(&root, &p, &b, meta.images.values().next().unwrap()).unwrap(),
        png()
    );
    let second = attach(&root, &p, &b, &src);
    assert_eq!(second.nodes[0].docs.len(), 1);
    let text = fs::read_to_string(doc_path(&root, &p, &b, &doc.path).unwrap())
        .unwrap()
        .replace("图文原文", "用户编辑");
    fs::write(doc_path(&root, &p, &b, &doc.path).unwrap(), text).unwrap();
    let output = std::env::temp_dir()
        .join(storage::new_id("export_bundle"))
        .with_extension("zip");
    export_at(&root, &p, &b, &doc.path, output.to_str().unwrap()).unwrap();
    let exported = unzip(&fs::read(&output).unwrap()).unwrap();
    assert!(String::from_utf8_lossy(&exported["answer.md"]).contains("用户编辑"));
    assert_eq!(exported["images/image-001.png"], png());
    fs::remove_file(output).unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn whole_board_roundtrip_and_tampering_leave_old_board_intact() {
    let (root, p, b) = setup();
    attach(&root, &p, &b, &bundle(&root));
    let before = fs::read(storage::board_file(&root, &p, &b)).unwrap();
    let bytes = portable_documents::export_at(&root, &p, &b).unwrap();
    let first = portable_documents::import_at(&root, &p, &bytes).unwrap();
    let second = portable_documents::import_at(&root, &p, &bytes).unwrap();
    assert_ne!(first.id, second.id);
    assert_ne!(first.nodes[0].id, "n1");
    assert_eq!(first.nodes[0].title, "n1");
    assert_eq!(
        fs::read(storage::board_file(&root, &p, &b)).unwrap(),
        before
    );
    for path in [first.nodes[0].docs[0].path.clone()] {
        let source = read_payload(&root, &p, &b, &path)
            .unwrap()
            .attachment
            .unwrap();
        let copy = read_payload(&root, &p, &first.id, &path)
            .unwrap()
            .attachment
            .unwrap();
        assert_eq!(
            verified_asset(&root, &p, &b, &source.original).unwrap(),
            verified_asset(&root, &p, &first.id, &copy.original).unwrap()
        );
    }
    let mut broken = unzip_limit(&bytes, 96 * 1024 * 1024, 10000).unwrap();
    let key = broken.keys().find(|p| p.ends_with(".png")).unwrap().clone();
    broken.get_mut(&key).unwrap().push(1);
    let count = storage::read_project(&root, &p).unwrap().boards.len();
    assert!(portable_documents::import_at(
        &root,
        &p,
        &portable_documents::archive(&broken).unwrap()
    )
    .is_err());
    assert_eq!(
        storage::read_project(&root, &p).unwrap().boards.len(),
        count
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn rich_backup_restores_missing_images_and_original_pdf() {
    let (root, p, b) = setup();
    let board = attach(&root, &p, &b, &bundle(&root));
    let doc = &board.nodes[0].docs[0];
    let meta = read_payload(&root, &p, &b, &doc.path)
        .unwrap()
        .attachment
        .unwrap();
    let (name, backup) = board_operations::backup_at(&root, &p, &b, "测试").unwrap();
    let backup_dir = storage::board_dir(&root, &p, &b).join(".ai-backups");
    fs::create_dir_all(&backup_dir).unwrap();
    fs::write(backup_dir.join(&name), backup).unwrap();
    let image = meta.images.values().next().unwrap();
    fs::remove_file(doc_path(&root, &p, &b, &image.path).unwrap()).unwrap();
    board_operations::restore_at(
        &root,
        &p,
        &b,
        &name,
        &sync::board_revision(&root, &p, &b).unwrap(),
        20,
    )
    .unwrap();
    assert_eq!(verified_asset(&root, &p, &b, image).unwrap(), png());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn bad_inputs_and_stale_board_never_write_assets() {
    let (root, p, b) = setup();
    let before = fs::read(storage::board_file(&root, &p, &b)).unwrap();
    let mut entries = BTreeMap::from([
        ("answer.md".into(), b"text".to_vec()),
        ("../escape.png".into(), png()),
    ]);
    let path = root.join("bad.zip");
    fs::write(&path, portable_documents::archive(&entries).unwrap()).unwrap();
    assert!(prepare(&path, "", "", 0).is_err());
    entries.remove("../escape.png");
    for i in 0..257 {
        entries.insert(format!("images/{i}.png"), png());
    }
    fs::write(&path, portable_documents::archive(&entries).unwrap()).unwrap();
    assert!(prepare(&path, "", "", 0).is_err());
    let src = bundle(&root);
    assert!(attach_at(
        &root,
        &p,
        &b,
        "n1",
        "stale",
        prepare(&src, "", "", 0).unwrap(),
        20
    )
    .is_err());
    assert_eq!(
        fs::read(storage::board_file(&root, &p, &b)).unwrap(),
        before
    );
    assert_eq!(
        fs::read_dir(storage::docs_dir(&root, &p, &b))
            .unwrap()
            .count(),
        0
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn write_failure_after_board_before_documents_rolls_back_everything() {
    let (root, p, b) = setup();
    let src = bundle(&root);
    let before = fs::read(storage::board_file(&root, &p, &b)).unwrap();
    let docs = storage::docs_dir(&root, &p, &b);
    fs::remove_dir(&docs).unwrap();
    fs::write(&docs, b"blocking file").unwrap();
    assert!(attach_at(
        &root,
        &p,
        &b,
        "n1",
        &sync::board_revision(&root, &p, &b).unwrap(),
        prepare(&src, "", "", 0).unwrap(),
        20
    )
    .is_err());
    assert_eq!(
        fs::read(storage::board_file(&root, &p, &b)).unwrap(),
        before
    );
    assert_eq!(fs::read(&docs).unwrap(), b"blocking file");
    assert!(!root.join(".lumen-sync/pending.json").exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn pdf_text_is_separate_and_original_export_is_byte_exact() {
    let (root, p, b) = setup();
    let src = root.join("中文.pdf");
    let bytes = b"%PDF-1.7\nsynthetic bytes\n%%EOF";
    fs::write(&src, bytes).unwrap();
    let prepared = prepare(&src, &hash(bytes), "## 第 1 页\n\n可检索正文", 1).unwrap();
    let board = attach_at(
        &root,
        &p,
        &b,
        "n1",
        &sync::board_revision(&root, &p, &b).unwrap(),
        prepared,
        20,
    )
    .unwrap();
    let doc = &board.nodes[0].docs[0];
    let payload = read_payload(&root, &p, &b, &doc.path).unwrap();
    assert!(payload.markdown.contains("可检索正文"));
    assert_eq!(payload.attachment.as_ref().unwrap().pages, 1);
    assert_eq!(
        verified_asset(&root, &p, &b, &payload.attachment.unwrap().original).unwrap(),
        bytes
    );
    let output = std::env::temp_dir()
        .join(storage::new_id("pdf_export"))
        .with_extension("pdf");
    export_at(&root, &p, &b, &doc.path, output.to_str().unwrap()).unwrap();
    assert_eq!(fs::read(&output).unwrap(), bytes);
    fs::remove_file(output).unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn imported_conversation_links_use_new_ids_but_plain_source_words_do_not_change() {
    let (root, p, b) = setup();
    let content =
        format!("n1\n\n[返回原对话](lumen://conversation/c1?messages=m1,m2&project={p}&board={b})");
    let doc = storage::write_doc(&root, &p, &b, "聊天", &content).unwrap();
    let mut board = storage::load_board(&root, &p, &b).unwrap();
    board.nodes[0].docs.push(doc.clone());
    storage::save_board(&root, &board).unwrap();
    storage::write_chats(&root,&p,&b,&json!({"version":1,"conversations":[{"id":"c1","sourceNodeId":"n1","messages":[{"id":"m1","role":"user","content":"n1"},{"id":"m2","role":"assistant","content":"content"}]}]}).to_string()).unwrap();
    let copied = portable_documents::import_at(
        &root,
        &p,
        &portable_documents::export_at(&root, &p, &b).unwrap(),
    )
    .unwrap();
    let raw = storage::read_doc(&root, &p, &copied.id, &doc.path).unwrap();
    let chats: serde_json::Value =
        serde_json::from_str(&storage::read_chats(&root, &p, &copied.id).unwrap()).unwrap();
    let c = &chats["conversations"][0];
    assert!(raw.starts_with("n1\n"));
    assert_eq!(c["messages"][0]["content"], "n1");
    assert!(!raw.contains("m1,m2"));
    assert!(raw.contains(c["id"].as_str().unwrap()));
    assert!(raw.contains(c["messages"][1]["id"].as_str().unwrap()));
    assert!(raw.contains(&copied.id));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn archive_rejects_cross_platform_case_and_unicode_collisions() {
    for names in [
        ["images/A.png", "images/a.png"],
        ["images/é.png", "images/e\u{301}.png"],
    ] {
        let bytes = portable_documents::archive(&BTreeMap::from([
            (names[0].into(), png()),
            (names[1].into(), png()),
            ("answer.md".into(), b"source".to_vec()),
        ]))
        .unwrap();
        assert!(unzip(&bytes).is_err());
    }
}

#[test]
fn restoring_corrupt_asset_preserves_damaged_before_image_and_recovers_verified_copy() {
    let (root, p, b) = setup();
    let board = attach(&root, &p, &b, &bundle(&root));
    let doc = &board.nodes[0].docs[0];
    let meta = read_payload(&root, &p, &b, &doc.path)
        .unwrap()
        .attachment
        .unwrap();
    let asset = meta.images.values().next().unwrap();
    let (name, backup) = board_operations::backup_at(&root, &p, &b, "测试").unwrap();
    let dir = storage::board_dir(&root, &p, &b).join(".ai-backups");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(&name), &backup).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&backup).unwrap();
    assert_eq!(value["schema"], "lumen.board-backup/v2");
    assert!(value["files"][&asset.path].is_string());
    fs::write(
        doc_path(&root, &p, &b, &asset.path).unwrap(),
        b"damaged but preserved",
    )
    .unwrap();
    board_operations::restore_at(
        &root,
        &p,
        &b,
        &name,
        &sync::board_revision(&root, &p, &b).unwrap(),
        20,
    )
    .unwrap();
    assert_eq!(verified_asset(&root, &p, &b, asset).unwrap(), png());
    let has_insurance = fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|e| fs::read(e.path()).ok())
        .any(|bytes| {
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .is_some_and(|v| {
                    v["reason"] == "恢复前保险"
                        && v["invalid"]
                            .as_array()
                            .is_some_and(|a| a.contains(&json!(asset.path)))
                })
        });
    assert!(has_insurance);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn portable_unbound_knowledge_and_capture_provenance_are_remapped_in_a_new_library() {
    let (root, p, b) = setup();
    let now = storage::now_iso();
    let entry = json!({"id":"entry","revision_id":"revision","kind":"understanding","title":"理解","body":"原始理解","source":"","authorship":"user","basis_json":"[]","archived":0,"created_at":now,"updated_at":now});
    let revision = json!({"id":"revision","entry_id":"entry","kind":"understanding","title":"理解","body":"原始理解","source":"","authorship":"user","basis_json":"[]","created_at":now});
    fs::create_dir_all(root.join("knowledge")).unwrap();
    fs::write(
        root.join("knowledge/library.json"),
        json!({"version":1,"entries":[entry],"revisions":[revision],"bindings":[],"settings":[]})
            .to_string(),
    )
    .unwrap();
    let doc = storage::write_doc(
        &root,
        &p,
        &b,
        "原始",
        "# 保留\n\n[理解](learnstuff-knowledge://entry/revision)",
    )
    .unwrap();
    let mut board = storage::load_board(&root, &p, &b).unwrap();
    board.nodes[0].docs.push(doc.clone());
    storage::save_board(&root, &board).unwrap();
    storage::write_chats(&root,&p,&b,&json!({"version":1,"conversations":[{"id":"c1","messages":[{"id":"m1","role":"user","content":"问"},{"id":"m2","role":"assistant","content":"答"}]}]}).to_string()).unwrap();
    fs::write(storage::board_dir(&root,&p,&b).join("chat-captures.json"),json!([{"id":"capture","conversation_id":"c1","node_id":"n1","document_path":doc.path,"message_ids_json":"[\"m1\",\"m2\"]","selection_key":"chat:c1:m1,m2"}]).to_string()).unwrap();
    let (target, target_p, _) = setup();
    let copied = portable_documents::import_at(
        &target,
        &target_p,
        &portable_documents::export_at(&root, &p, &b).unwrap(),
    )
    .unwrap();
    let library: serde_json::Value =
        serde_json::from_slice(&fs::read(target.join("knowledge/library.json")).unwrap()).unwrap();
    let copied_entry = &library["entries"][0];
    let copied_revision = &library["revisions"][0];
    let body = storage::read_doc(&target, &target_p, &copied.id, &doc.path).unwrap();
    assert!(body.contains(&format!(
        "learnstuff-knowledge://{}/{}",
        copied_entry["id"].as_str().unwrap(),
        copied_revision["id"].as_str().unwrap()
    )));
    let captures: serde_json::Value = serde_json::from_slice(
        &fs::read(storage::board_dir(&target, &target_p, &copied.id).join("chat-captures.json"))
            .unwrap(),
    )
    .unwrap();
    assert_ne!(captures[0]["id"], "capture");
    assert_eq!(captures[0]["node_id"], copied.nodes[0].id);
    assert!(!captures[0]["message_ids_json"]
        .as_str()
        .unwrap()
        .contains("m1"));
    assert!(library["bindings"].as_array().unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(target).unwrap();
}

#[test]
fn actual_android_apk_export_opens_and_reexports_all_rich_originals() {
    // Produced through Android's real SAF export with isolated demo data only.
    let (root,p,_)=setup();
    let bytes=include_bytes!("../../scripts/fixtures/android-rich-board.zip");
    let board=portable_documents::import_at(&root,&p,bytes).unwrap();
    assert_eq!(board.nodes.len(),6);
    let mut rich=0;
    for node in &board.nodes { for doc in &node.docs {
        let payload=read_payload(&root,&p,&board.id,&doc.path).unwrap();
        if let Some(meta)=payload.attachment {rich+=1;assert!(!verified_asset(&root,&p,&board.id,&meta.original).unwrap().is_empty());for image in meta.images.values(){assert!(!verified_asset(&root,&p,&board.id,image).unwrap().is_empty());}}
    }}
    assert_eq!(rich,5);
    let copied=portable_documents::import_at(&root,&p,&portable_documents::export_at(&root,&p,&board.id).unwrap()).unwrap();
    assert_ne!(copied.id,board.id);assert_eq!(copied.nodes.len(),6);
    fs::remove_dir_all(root).unwrap();
}
