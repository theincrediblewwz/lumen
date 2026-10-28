//! Explicitly previewed imports. Ordinary autonomous AI operation limits do not change.
use crate::{board_operations as safety, commands, config, storage, sync};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn hash(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OriginalAnswer {
    pub id: String,
    pub content: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreeNode {
    pub reference: String,
    pub title: String,
    pub summary: String,
    pub markdown: String,
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<OriginalAnswer>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreePlan {
    pub schema: String,
    pub title: String,
    pub nodes: Vec<TreeNode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Import {
    pub plan: TreePlan,
    pub source: String,
    pub source_name: String,
    pub source_url: Option<String>,
    #[serde(default)]
    pub selection: Option<String>,
    pub attach_node_id: Option<String>,
}
fn validate(import: &Import) -> Result<(), String> {
    let faithful = match import.plan.mode.as_deref() {
        None => false,
        Some("faithful") => true,
        Some(_) => return Err("不支持的对话整理模式".into()),
    };
    if import.plan.schema != "lumen.conversation-tree/v1"
        || import.plan.nodes.is_empty()
        || import.source.trim().is_empty()
        || import.source.len() > 32 * 1024 * 1024
    {
        return Err("对话或树结构无效，须有节点且原文最多32MiB".into());
    }
    if import.plan.title.trim().is_empty()
        || import.plan.title.len() > 600
        || import.source_name.len() > 600
        || import.source_name.contains(['\r', '\n'])
    {
        return Err("导入标题无效".into());
    }
    if import
        .selection
        .as_ref()
        .is_some_and(|note| note.len() > 1024 * 1024)
    {
        return Err("轮次选择记录超过处理预算".into());
    }
    let mut refs = BTreeMap::<String, usize>::new();
    let mut roots = 0;
    let mut bytes = 0;
    let mut original_ids = BTreeSet::new();
    let mut original_bytes = 0_usize;
    for node in &import.plan.nodes {
        storage::safe_id(&node.reference)?;
        if refs.contains_key(&node.reference)
            || node.title.trim().is_empty()
            || node.title.len() > 600
            || node.summary.len() > 8000
            || node.markdown.trim().is_empty()
            || node.markdown.len() > 64 * 1024
        {
            return Err("节点标识、标题或正文无效".into());
        }
        if let Some(original) = &node.original {
            storage::safe_id(&original.id)?;
            if !faithful
                || !original_ids.insert(&original.id)
                || original.content.trim().is_empty()
                || original.content.len() > import.source.len()
                || !import.source.contains(&original.content)
            {
                return Err("忠实原回答必须来自完整原文、标识唯一，且仅用于忠实模式".into());
            }
            original_bytes = original_bytes
                .checked_add(original.content.len())
                .ok_or("忠实原回答超过处理预算")?;
            if original_bytes > import.source.len() {
                return Err("忠实原回答总量超过完整原文大小".into());
            }
        } else if faithful && node.parent.is_some() {
            return Err("忠实模式除总览根节点外，每个节点必须包含完整原回答".into());
        }
        let depth = if let Some(parent) = &node.parent {
            refs.get(parent)
                .ok_or("父节点必须在子节点之前，且属于本次导入")?
                + 1
        } else {
            roots += 1;
            0
        };
        refs.insert(node.reference.clone(), depth);
        bytes += node.markdown.len();
    }
    if roots != 1 || bytes > 2 * 1024 * 1024 {
        return Err("须有且仅有一个根节点，整理正文最多2MiB".into());
    }
    if faithful && original_ids.is_empty() {
        return Err("忠实模式至少须有一条完整原回答".into());
    }
    Ok(())
}
fn project_bytes(root: &Path, p: &str) -> Result<Vec<u8>, String> {
    fs::read(safety::checked_path(root, &format!("{p}/project.json"))?).map_err(error)
}
fn with_revision(root: &Path, board: &storage::BoardFile) -> Result<Value, String> {
    let mut value = serde_json::to_value(board).map_err(error)?;
    value["_disk_revision"] = json!(sync::board_revision(root, &board.project_id, &board.id)?);
    Ok(value)
}
#[tauri::command]
pub fn conversation_import_context(project_id: String) -> Result<Value, String> {
    let _g = sync::IO_LOCK.lock().map_err(error)?;
    storage::safe_id(&project_id)?;
    let root = commands::root()?;
    Ok(
        json!({"scope":safety::scope(&root)?,"projectRevision":hash(&project_bytes(&root,&project_id)?)}),
    )
}
fn apply_at(
    root: &Path,
    p: &str,
    b: Option<&str>,
    expected: &str,
    project_revision: &str,
    request: &str,
    import: Import,
    keep: usize,
) -> Result<Value, String> {
    storage::safe_id(p)?;
    storage::safe_id(request)?;
    if let Some(b) = b {
        storage::safe_id(b)?;
    }
    validate(&import)?;
    sync::recover(root)?;
    let digest = hash(&serde_json::to_vec(&json!({"board":b,"import":import})).map_err(error)?);
    let receipt_path = format!("{p}/.conversation-imports/{request}.json");
    let receipt_file = safety::checked_path(root, &receipt_path)?;
    if receipt_file.exists() {
        let old: Value =
            serde_json::from_slice(&fs::read(receipt_file).map_err(error)?).map_err(error)?;
        if old["digest"] != digest {
            return Err("重复导入标识对应了不同内容".into());
        }
        let board = storage::load_board(root, p, old["boardId"].as_str().ok_or("导入回执无效")?)?;
        if old["nodes"]
            .as_array()
            .ok_or("导入回执无效")?
            .iter()
            .any(|id| {
                !board
                    .nodes
                    .iter()
                    .any(|n| Some(n.id.as_str()) == id.as_str())
            })
        {
            return Err("导入已被恢复或移除，未自动重放".into());
        }
        let edges = old["edges"].as_array().ok_or("导入连线回执无效")?;
        if edges.iter().any(|id| {
            !board
                .edges
                .iter()
                .any(|e| Some(e.id.as_str()) == id.as_str())
        }) {
            return Err("导入连线已移除，未自动重放".into());
        }
        for (node_id, paths) in old["documents"].as_object().ok_or("导入文档回执无效")? {
            let node = board
                .nodes
                .iter()
                .find(|n| &n.id == node_id)
                .ok_or("导入节点已移除")?;
            for path in paths.as_array().ok_or("导入文档回执无效")? {
                let path = path.as_str().ok_or("导入文档回执无效")?;
                if !node.docs.iter().any(|d| d.path == path)
                    || !safety::checked_path(root, &format!("{p}/{}/{path}", board.id))?.is_file()
                {
                    return Err("导入文档已移除，未自动重放".into());
                }
            }
        }
        let source_path = old["sourcePath"].as_str().ok_or("原文回执无效")?;
        if hash(
            &fs::read(safety::checked_path(
                root,
                &format!("{p}/{}/{}", board.id, source_path),
            )?)
            .map_err(error)?,
        ) != hash(import.source.as_bytes())
        {
            return Err("原始对话已变化或缺失，未自动重放导入".into());
        }
        return Ok(
            json!({"board":with_revision(root,&board)?,"rootNodeId":old["nodes"][0],"summary":old["summary"],"reused":true}),
        );
    }
    let now = storage::now_iso();
    let mut files = BTreeMap::new();
    let mut board = if let Some(id) = b {
        safety::checked_path(root, &format!("{p}/{id}/board.json"))?;
        if sync::board_revision(root, p, id)? != expected {
            return Err("白板内容已改变，导入尚未写入，请重新预览".into());
        }
        storage::load_board(root, p, id)?
    } else {
        let original = project_bytes(root, p)?;
        if hash(&original) != project_revision {
            return Err("项目已改变，请重新预览新白板".into());
        }
        let id = format!("b_{request}");
        storage::safe_id(&id)?;
        if safety::checked_path(root, &format!("{p}/{id}/board.json"))?.exists() {
            return Err("新白板目录已存在，未覆盖".into());
        }
        let mut project: Value = serde_json::from_slice(&original).map_err(error)?;
        project["boards"]
            .as_array_mut()
            .ok_or("项目格式无效")?
            .push(json!({"id":id,"name":import.plan.title,"updated_at":now}));
        project["updated_at"] = json!(now);
        files.insert(
            format!("{p}/project.json"),
            serde_json::to_vec_pretty(&project).map_err(error)?,
        );
        storage::BoardFile {
            version: 1,
            id,
            name: import.plan.title.clone(),
            project_id: p.into(),
            created_at: now.clone(),
            updated_at: now.clone(),
            viewport: storage::Viewport::default(),
            nodes: vec![],
            edges: vec![],
            extra: BTreeMap::new(),
        }
    };
    let base = format!("{p}/{}", board.id);
    if let Some(parent) = &import.attach_node_id {
        if b.is_none() || !board.nodes.iter().any(|n| &n.id == parent) {
            return Err("选定的来源节点已不存在".into());
        }
    }
    let (backup, backup_bytes) = if b.is_some() {
        safety::backup_at(root, p, &board.id, "导入对话前")?
    } else {
        (format!("{}.json",storage::new_id("version")),serde_json::to_vec(&json!({"schema":"lumen.board-backup/v1","project":p,"board":board.id,"created_at":now,"reason":"导入对话前","missing":[],"files":{"board.json":serde_json::to_vec_pretty(&board).map_err(error)?}})).map_err(error)?)
    };
    files.insert(format!("{base}/.ai-backups/{backup}"), backup_bytes);
    let source_path = format!("docs/source_{request}.md");
    files.insert(
        format!("{base}/{source_path}"),
        import.source.as_bytes().to_vec(),
    );
    let origin_x = board
        .nodes
        .iter()
        .map(|n| n.x + n.w)
        .fold(0.0_f64, f64::max)
        + 80.;
    let mut spans = BTreeMap::<String, usize>::new();
    for node in import.plan.nodes.iter().rev() {
        let span = (*spans.get(&node.reference).unwrap_or(&0)).max(1);
        spans.insert(node.reference.clone(), span);
        if let Some(parent) = &node.parent {
            *spans.entry(parent.clone()).or_default() += span;
        }
    }
    let mut refs = BTreeMap::<String, (String, usize)>::new();
    let mut cursors = BTreeMap::<String, f64>::new();
    let mut created = vec![];
    let mut created_edges = vec![];
    let mut created_documents = BTreeMap::<String, Vec<String>>::new();
    for (index, node) in import.plan.nodes.iter().enumerate() {
        let (parent, depth) = match &node.parent {
            Some(parent) => {
                let (id, depth) = refs.get(parent).ok_or("父节点不存在")?;
                (Some(id.clone()), depth + 1)
            }
            None => (import.attach_node_id.clone(), 0),
        };
        let id = storage::new_id("n_import");
        let span = spans[&node.reference] as f64;
        let start = if let Some(parent) = &node.parent {
            let cursor = cursors.get_mut(parent).ok_or("父节点布局无效")?;
            let start = *cursor;
            *cursor += span * 260.;
            start
        } else {
            80.
        };
        cursors.insert(node.reference.clone(), start);
        let y = start + (span - 1.) * 130.;
        let path = format!("docs/import_{request}_{index}.md");
        let markdown = if import.plan.mode.as_deref() == Some("faithful") {
            let mut document = format!(
                "> 忠实逐轮导入：AI 仅补充导读与层级说明，原回答按导入资料完整保留，内容未经独立核实。[阅读完整原文](source_{request}.md)\n\n## AI导读（含层级说明）\n\n{}",
                node.markdown,
            );
            if let Some(original) = &node.original {
                document.push_str("\n\n---\n\n## 原始AI回答（未改写）\n\n");
                // The original is the exact source slice. Never trim, normalize, or append
                // anything after it: CRLF, formulas and trailing whitespace are user data.
                document.push_str(&original.content);
            }
            document
        } else {
            format!(
                "> AI 根据导入对话整理，未经独立核实。[阅读完整原文](source_{request}.md)\n\n{}",
                node.markdown,
            )
        };
        files.insert(format!("{base}/{path}"), markdown.as_bytes().to_vec());
        let mut docs = vec![storage::DocRef {
            path,
            title: node.title.clone(),
            bytes: Some(markdown.len() as u64),
        }];
        if node.parent.is_none() {
            docs.push(storage::DocRef {
                path: source_path.clone(),
                title: format!("原始对话 · {}", import.source_name),
                bytes: Some(import.source.len() as u64),
            });
            if let Some(selection) = &import.selection {
                let path = format!("docs/selection_{request}.md");
                files.insert(format!("{base}/{path}"), selection.as_bytes().to_vec());
                docs.push(storage::DocRef {
                    path,
                    title: "本次整理的轮次".into(),
                    bytes: Some(selection.len() as u64),
                });
            }
        }
        created_documents.insert(id.clone(), docs.iter().map(|d| d.path.clone()).collect());
        board.nodes.push(storage::BoardNode {
            id: id.clone(),
            title: node.title.clone(),
            summary: Some(node.summary.clone()),
            x: origin_x + depth as f64 * 340.,
            y,
            w: 240.,
            color: None,
            docs,
            created_at: now.clone(),
            updated_at: now.clone(),
        });
        if let Some(from) = parent {
            let edge_id = storage::new_id("e_import");
            created_edges.push(edge_id.clone());
            board.edges.push(storage::BoardEdge {
                id: edge_id,
                from,
                to: id.clone(),
                directed: true,
                label: None,
                created_at: now.clone(),
            });
        }
        refs.insert(node.reference.clone(), (id.clone(), depth));
        created.push(id);
    }
    board.updated_at = now;
    files.insert(
        format!("{base}/board.json"),
        serde_json::to_vec_pretty(&board).map_err(error)?,
    );
    let summary = if import.plan.mode.as_deref() == Some("faithful") {
        format!(
            "已忠实导入 {} 条完整原回答，共 {} 个节点，完整原文已保留。",
            import
                .plan
                .nodes
                .iter()
                .filter(|node| node.original.is_some())
                .count(),
            created.len()
        )
    } else {
        format!("已导入 {} 个节点，完整原文已保留。", created.len())
    };
    files.insert(receipt_path,serde_json::to_vec(&json!({"digest":digest,"boardId":board.id,"nodes":created,"edges":created_edges,"documents":created_documents,"summary":summary,"sourcePath":source_path,"sourceUrl":import.source_url})).map_err(error)?);
    for path in files.keys() {
        let target = safety::checked_path(root, path)?;
        if path.starts_with(&format!("{base}/docs/")) && target.exists() {
            return Err("导入文档路径已存在，原件未覆盖".into());
        }
    }
    sync::transaction(root, files)?;
    let warning = safety::prune(root, p, &board.id, keep).err();
    Ok(
        json!({"board":with_revision(root,&board)?,"rootNodeId":created[0],"summary":summary,"warning":warning,"reused":false}),
    )
}
#[tauri::command]
pub fn conversation_import_apply(
    project_id: String,
    board_id: Option<String>,
    expected_revision: String,
    project_revision: String,
    expected_scope: String,
    request_id: String,
    import: Import,
) -> Result<Value, String> {
    let _g = sync::IO_LOCK.lock().map_err(error)?;
    let root = commands::root()?;
    if safety::scope(&root)? != expected_scope {
        return Err("资料目录已变化，请重新预览".into());
    }
    let keep = safety::policy_at(&config::config_dir()?)?.keep;
    apply_at(
        &root,
        &project_id,
        board_id.as_deref(),
        &expected_revision,
        &project_revision,
        &request_id,
        import,
        keep,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_round_record_does_not_replace_or_shorten_a_large_original() {
        let (root, p, _) = setup();
        let revision = hash(&project_bytes(&root, &p).unwrap());
        let mut input = sample();
        input.source = "original source\n".repeat(200000);
        input.selection = Some("本次只整理第2轮；全文保留".into());
        let original = input.source.clone();
        let result =
            apply_at(&root, &p, None, "", &revision, "import_selected", input, 20).unwrap();
        let board: storage::BoardFile = serde_json::from_value(result["board"].clone()).unwrap();
        let docs = &board.nodes[0].docs;
        assert_eq!(
            storage::read_doc(&root, &p, &board.id, "docs/source_import_selected.md").unwrap(),
            original
        );
        assert!(docs
            .iter()
            .any(|doc| doc.path == "docs/selection_import_selected.md"));
        assert!(
            storage::read_doc(&root, &p, &board.id, "docs/selection_import_selected.md")
                .unwrap()
                .contains("第2轮")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn deep_import_keeps_every_level_and_reopens_without_flattening() {
        let (r, p, _) = setup();
        let revision = hash(&project_bytes(&r, &p).unwrap());
        let mut input = sample();
        input.plan.nodes = (0..128)
            .map(|i| TreeNode {
                reference: format!("level{i}"),
                title: format!("Level {i}"),
                summary: "question".into(),
                markdown: format!("# Level {i}"),
                original: None,
                parent: if i == 0 {
                    None
                } else {
                    Some(format!("level{}", i - 1))
                },
            })
            .collect();
        let result = apply_at(&r, &p, None, "", &revision, "deep_import", input, 20).unwrap();
        let id = result["board"]["id"].as_str().unwrap();
        let board = storage::load_board(&r, &p, id).unwrap();
        assert_eq!(board.nodes.len(), 128);
        assert_eq!(board.edges.len(), 127);
        for i in 1..128 {
            assert!(board
                .edges
                .iter()
                .any(|e| e.from == board.nodes[i - 1].id && e.to == board.nodes[i].id));
        }
        fs::remove_dir_all(r).unwrap();
    }
    fn setup() -> (std::path::PathBuf, String, String) {
        let r = std::env::temp_dir().join(storage::new_id("lumen_import_test"));
        storage::ensure_storage(&r).unwrap();
        let p = storage::create_project(&r, "P").unwrap().id;
        let b = storage::create_board(&r, &p, "Original").unwrap().id;
        (r, p, b)
    }
    fn sample() -> Import {
        Import {
            selection: None,
            source: "\u{feff}# 原始问答\r\n\r\n**回答** $x_i$\r\n".into(),
            source_name: "对话.md".into(),
            source_url: None,
            attach_node_id: None,
            plan: TreePlan {
                schema: "lumen.conversation-tree/v1".into(),
                title: "理解问题".into(),
                mode: None,
                nodes: vec![
                    TreeNode {
                        reference: "root".into(),
                        original: None,
                        title: "根".into(),
                        summary: "摘要".into(),
                        markdown: "# AI整理\n\n$x_i$".into(),
                        parent: None,
                    },
                    TreeNode {
                        reference: "child".into(),
                        original: None,
                        title: "下一问".into(),
                        summary: "继续".into(),
                        markdown: "## 证据".into(),
                        parent: Some("root".into()),
                    },
                ],
            },
        }
    }
    fn faithful(answer: &str) -> Import {
        let mut input = sample();
        input.source = format!("\u{feff}# 问答记录\r\n\r\n## 回答\r\n{answer}");
        input.plan.mode = Some("faithful".into());
        input.plan.nodes[0].markdown = "# 总览\n\n按原回答组织学习路径。".into();
        input.plan.nodes[1].markdown =
            "先读原回答的定义，再检查公式。\n\n层级理由：这是总问题的直接回答。".into();
        input.plan.nodes[1].original = Some(OriginalAnswer {
            id: "answer_2".into(),
            content: answer.into(),
        });
        input
    }

    #[test]
    fn faithful_large_answer_reopens_byte_for_byte_after_separate_ai_guidance() {
        let (root, p, _) = setup();
        let revision = hash(&project_bytes(&root, &p).unwrap());
        let answer = "**原回答，保留两个尾空格** $x_i$  \r\n\\[\r\nx_{i+1}=x_i+1\\\r\n\\]\r\n\r\n"
            .repeat(2200)
            + "$$a=b$$  \r\n\r\n\r\n";
        assert!(answer.len() > 64 * 1024);
        let input = faithful(&answer);
        let result = apply_at(
            &root,
            &p,
            None,
            "",
            &revision,
            "faithful_large",
            input.clone(),
            20,
        )
        .unwrap();
        let id = result["board"]["id"].as_str().unwrap();
        let board = storage::load_board(&root, &p, id).unwrap();
        let doc = &board.nodes[1].docs[0];
        let raw = fs::read(storage::board_dir(&root, &p, id).join(&doc.path)).unwrap();
        let reopened = storage::read_doc(&root, &p, id, &doc.path).unwrap();
        assert_eq!(raw, reopened.as_bytes());
        let (guidance, original) = reopened.split_once("## 原始AI回答（未改写）\n\n").unwrap();
        assert!(guidance.contains("## AI导读（含层级说明）"));
        assert!(guidance.contains(&input.plan.nodes[1].markdown));
        assert!(!guidance.contains("AI 根据导入对话整理"));
        assert_eq!(original.as_bytes(), answer.as_bytes());
        assert_eq!(doc.bytes, Some(raw.len() as u64));
        assert_eq!(
            fs::read(storage::docs_dir(&root, &p, id).join("source_faithful_large.md")).unwrap(),
            input.source.as_bytes()
        );
        assert!(result["summary"]
            .as_str()
            .unwrap()
            .contains("忠实导入 1 条完整原回答"));
        assert_eq!(
            apply_at(&root, &p, None, "", &revision, "faithful_large", input, 20).unwrap()
                ["reused"],
            true
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn faithful_original_validation_rejects_forgery_before_any_disk_mutation() {
        let (root, p, b) = setup();
        let project_before = project_bytes(&root, &p).unwrap();
        let board_before = fs::read(storage::board_file(&root, &p, &b)).unwrap();
        let revision = sync::board_revision(&root, &p, &b).unwrap();
        let answer = "真实原回答 $x_i$  \r\n\r\n";
        for kind in [
            "forged",
            "normalized",
            "legacy",
            "duplicate",
            "missing",
            "unknown-mode",
            "empty",
        ] {
            let mut input = faithful(answer);
            match kind {
                "forged" => {
                    input.plan.nodes[1].original.as_mut().unwrap().content =
                        "AI 伪造的另一段回答".into()
                }
                "normalized" => {
                    input.plan.nodes[1].original.as_mut().unwrap().content =
                        answer.replace("\r\n", "\n")
                }
                "legacy" => input.plan.mode = None,
                "duplicate" => {
                    input.source.push_str(answer);
                    let mut duplicate = input.plan.nodes[1].clone();
                    duplicate.reference = "duplicate".into();
                    input.plan.nodes.push(duplicate);
                }
                "missing" => input.plan.nodes[1].original = None,
                "unknown-mode" => input.plan.mode = Some("rewrite-original".into()),
                "empty" => input.plan.nodes[1]
                    .original
                    .as_mut()
                    .unwrap()
                    .content
                    .clear(),
                _ => unreachable!(),
            }
            let result = apply_at(
                &root,
                &p,
                Some(&b),
                &revision,
                "",
                &format!("invalid_{kind}"),
                input,
                20,
            );
            assert!(result.is_err(), "accepted invalid case {kind}");
            assert_eq!(project_bytes(&root, &p).unwrap(), project_before);
            assert_eq!(
                fs::read(storage::board_file(&root, &p, &b)).unwrap(),
                board_before
            );
            assert!(fs::read_dir(storage::docs_dir(&root, &p, &b))
                .unwrap()
                .next()
                .is_none());
            assert!(!root.join(&p).join(".conversation-imports").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn faithful_original_and_metadata_budgets_are_independent() {
        let answer = "long original answer\r\n".repeat(5000);
        let mut input = faithful(&answer);
        assert!(validate(&input).is_ok());
        input.plan.nodes[1].markdown = "m".repeat(64 * 1024 + 1);
        assert!(validate(&input).unwrap_err().contains("正文无效"));
        let mut repeated = faithful("answer");
        repeated.source = "answer".into();
        let mut second = repeated.plan.nodes[1].clone();
        second.reference = "another_node".into();
        second.original.as_mut().unwrap().id = "answer_4".into();
        repeated.plan.nodes.push(second);
        assert!(validate(&repeated)
            .unwrap_err()
            .contains("总量超过完整原文"));
        let mut metadata = faithful("answer");
        metadata.source = "answer ".repeat(33);
        let child = metadata.plan.nodes[1].clone();
        metadata.plan.nodes.truncate(1);
        for i in 0..33 {
            let mut node = child.clone();
            node.reference = format!("answer_node_{i}");
            node.original.as_mut().unwrap().id = format!("answer_{i}");
            node.markdown = "m".repeat(64 * 1024);
            metadata.plan.nodes.push(node);
        }
        assert!(validate(&metadata)
            .unwrap_err()
            .contains("整理正文最多2MiB"));
    }

    #[test]
    fn faithful_schema_is_explicit_and_legacy_payload_serialization_stays_compatible() {
        let old = serde_json::to_value(sample()).unwrap();
        assert!(old["plan"].get("mode").is_none());
        assert!(old["plan"]["nodes"][0].get("original").is_none());
        let decoded: Import = serde_json::from_value(old).unwrap();
        assert!(validate(&decoded).is_ok());
        let mut with_untrusted_field = serde_json::to_value(faithful("answer")).unwrap();
        with_untrusted_field["plan"]["nodes"][1]["original"]["path"] = json!("../../escape.md");
        assert!(serde_json::from_value::<Import>(with_untrusted_field).is_err());
    }

    #[test]
    fn new_board_is_atomic_preserves_source_and_repeated_apply_is_idempotent() {
        let (r, p, original) = setup();
        let before = fs::read(storage::board_file(&r, &p, &original)).unwrap();
        let revision = hash(&project_bytes(&r, &p).unwrap());
        let input = sample();
        let result =
            apply_at(&r, &p, None, "", &revision, "import_one", input.clone(), 20).unwrap();
        let board: storage::BoardFile = serde_json::from_value(result["board"].clone()).unwrap();
        let project: Value = serde_json::from_slice(&project_bytes(&r, &p).unwrap()).unwrap();
        assert_eq!(project["boards"].as_array().unwrap().len(), 2);
        assert_eq!(board.nodes.len(), 2);
        assert_eq!(board.edges.len(), 1);
        assert_eq!(
            fs::read(storage::docs_dir(&r, &p, &board.id).join("source_import_one.md")).unwrap(),
            input.source.as_bytes()
        );
        assert_eq!(
            fs::read(storage::board_file(&r, &p, &original)).unwrap(),
            before
        );
        assert_eq!(
            apply_at(&r, &p, None, "", &revision, "import_one", input.clone(), 20).unwrap()
                ["reused"],
            true
        );
        let mut edited = board.clone();
        edited.edges.clear();
        storage::save_board(&r, &edited).unwrap();
        assert!(apply_at(&r, &p, None, "", &revision, "import_one", input.clone(), 20).is_err());
        storage::save_board(&r, &board).unwrap();
        fs::remove_file(storage::board_dir(&r, &p, &board.id).join(&board.nodes[1].docs[0].path))
            .unwrap();
        assert!(apply_at(&r, &p, None, "", &revision, "import_one", input, 20).is_err());
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn existing_board_backup_restores_original_and_concurrent_edit_is_rejected() {
        let (r, p, b) = setup();
        let doc =
            storage::write_doc(&r, &p, &b, "original", "# Original\n\nUser owned $x_i$.").unwrap();
        let mut original = storage::load_board(&r, &p, &b).unwrap();
        original.nodes.push(storage::BoardNode {
            id: "original_node".into(),
            title: "User title".into(),
            summary: Some("User understanding".into()),
            x: 20.,
            y: 30.,
            w: 240.,
            color: None,
            docs: vec![doc.clone()],
            created_at: "now".into(),
            updated_at: "now".into(),
        });
        storage::save_board(&r, &original).unwrap();
        let rev = sync::board_revision(&r, &p, &b).unwrap();
        let old = fs::read(storage::board_file(&r, &p, &b)).unwrap();
        assert!(apply_at(&r, &p, Some(&b), "stale", "", "import_stale", sample(), 20).is_err());
        assert_eq!(fs::read(storage::board_file(&r, &p, &b)).unwrap(), old);
        let mut input = sample();
        input.attach_node_id = Some("original_node".into());
        let result = apply_at(&r, &p, Some(&b), &rev, "", "import_two", input.clone(), 20).unwrap();
        assert_eq!(result["board"]["nodes"].as_array().unwrap().len(), 3);
        assert!(result["board"]["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["from"] == "original_node"));
        let backup = fs::read_dir(storage::board_dir(&r, &p, &b).join(".ai-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let saved: Value = serde_json::from_slice(&fs::read(&backup).unwrap()).unwrap();
        let raw: Vec<u8> = serde_json::from_value(saved["files"]["board.json"].clone()).unwrap();
        assert_eq!(raw, old);
        let restored = safety::restore_at(
            &r,
            &p,
            &b,
            backup.file_name().unwrap().to_str().unwrap(),
            &sync::board_revision(&r, &p, &b).unwrap(),
            20,
        )
        .unwrap();
        assert_eq!(restored.nodes.len(), 1);
        assert_eq!(restored.nodes[0].title, "User title");
        assert_eq!(fs::read(storage::board_file(&r, &p, &b)).unwrap(), old);
        assert_eq!(
            storage::read_doc(&r, &p, &b, &doc.path).unwrap(),
            "# Original\n\nUser owned $x_i$."
        );
        assert!(apply_at(
            &r,
            &p,
            Some(&b),
            &sync::board_revision(&r, &p, &b).unwrap(),
            "",
            "import_two",
            input,
            20
        )
        .is_err());
        fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn invalid_tree_or_disk_failure_leaves_project_board_and_documents_unchanged() {
        let (r, p, b) = setup();
        let original_project = project_bytes(&r, &p).unwrap();
        let mut invalid = sample();
        invalid.plan.nodes[1].parent = Some("not_there".into());
        assert!(apply_at(
            &r,
            &p,
            Some(&b),
            &sync::board_revision(&r, &p, &b).unwrap(),
            "",
            "invalid",
            invalid,
            20
        )
        .is_err());
        let blocked = r.join(&p).join("b_import_failure").join("docs");
        fs::create_dir_all(blocked.parent().unwrap()).unwrap();
        fs::write(blocked, "synthetic disk failure").unwrap();
        assert!(apply_at(
            &r,
            &p,
            None,
            "",
            &hash(&original_project),
            "import_failure",
            sample(),
            20
        )
        .is_err());
        assert_eq!(project_bytes(&r, &p).unwrap(), original_project);
        assert!(!storage::board_file(&r, &p, "b_import_failure").exists());
        assert!(!r
            .join(&p)
            .join(".conversation-imports/import_failure.json")
            .exists());
        fs::remove_dir_all(r).unwrap();
    }
}
