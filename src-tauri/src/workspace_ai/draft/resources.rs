use super::*;
use crate::storage::{BoardNode, DocRef};

impl Draft<'_> {
    pub(super) fn apply_resource(&mut self, op: Operation) -> Result<(), String> {
        match op {
            Operation::AddMarkdown {
                board,
                node_id,
                title,
                markdown,
            } => {
                let (key, id) = self.document_node(&board, &node_id)?;
                let title = name_text(&title, 240)?;
                markdown_text(&markdown)?;
                let location = self.node_trail(&key, self.node(&key, &id)?);
                let path = format!("docs/{}.md", storage::new_id("note_ai"));
                self.files
                    .insert(doc_path(&key, &path), markdown.as_bytes().to_vec());
                self.node_mut(&key, &id)?.docs.push(DocRef {
                    path,
                    title: title.clone(),
                    bytes: Some(markdown.len() as u64),
                });
                self.record(
                    "新建 Markdown",
                    format!("{location} / {title}"),
                    None,
                    Some(markdown),
                    false,
                );
            }
            Operation::EditMarkdown {
                board,
                node_id,
                document_id,
                revision,
                markdown,
            } => {
                let (key, id) = self.document_node(&board, &node_id)?;
                let node = self.node(&key, &id)?;
                let doc = find_doc(node, &document_id)?.clone();
                let location = self.node_trail(&key, node);
                if doc.path.starts_with("docs/sticker_") {
                    return Err("图片原件不能覆盖为 Markdown".into());
                }
                markdown_text(&markdown)?;
                let full = doc_path(&key, &doc.path);
                let raw = self.file(&full)?.ok_or("找不到 Markdown 文件")?;
                if documents::hash(&raw) != revision {
                    return Err("Markdown 已更改，请重新读取后拟定修改".into());
                }
                let raw = String::from_utf8(raw).map_err(|_| "非 UTF-8 文档请先另存为 UTF-8")?;
                let (_, before) = documents::split(&raw)?;
                let writes = workspace_editing::prepare_markdown_update(
                    self.root, &key.0, &key.1, &doc.path, &raw, &markdown, before,
                )?;
                if let Some(updated) = writes.get(&full) {
                    let length = updated.len() as u64;
                    for doc in self
                        .board_mut(&key)
                        .nodes
                        .iter_mut()
                        .flat_map(|n| &mut n.docs)
                        .filter(|d| d.path == doc.path)
                    {
                        doc.bytes = Some(length);
                    }
                }
                self.files.extend(writes);
                self.record(
                    "编辑 Markdown",
                    format!("{location} / {}", doc.title),
                    Some(before.into()),
                    Some(markdown),
                    false,
                );
            }
            Operation::RenameDocument {
                board,
                node_id,
                document_id,
                title,
            } => {
                let (key, id) = self.document_node(&board, &node_id)?;
                let node = self.node(&key, &id)?;
                let old = find_doc(node, &document_id)?;
                let location = format!("{} / {}", self.node_trail(&key, node), old.title);
                let title = name_text(&title, 240)?;
                let target = self
                    .node_mut(&key, &id)?
                    .docs
                    .iter_mut()
                    .find(|d| doc_id(&d.path) == document_id)
                    .unwrap();
                target.title = title.clone();
                self.record("重命名附件", location, None, Some(title), false);
            }
            Operation::AttachDocument {
                board,
                source_board,
                from_node_id,
                document_id,
                to_node_id,
            } => {
                let (target, to) = self.document_node(&board, &to_node_id)?;
                let (source, from) =
                    self.document_node(source_board.as_ref().unwrap_or(&board), &from_node_id)?;
                let source_node = self.node(&source, &from)?;
                let doc = find_doc(source_node, &document_id)?.clone();
                let source_location =
                    format!("{} / {}", self.node_trail(&source, source_node), doc.title);
                let location = self.node_trail(&target, self.node(&target, &to)?);
                let raw = self
                    .file(&doc_path(&source, &doc.path))?
                    .ok_or("附件原件已不存在")?;
                if source != target {
                    for asset in documents::dependencies(&raw)? {
                        let bytes = self
                            .file(&doc_path(&source, &asset.path))?
                            .ok_or("附件资源已不存在")?;
                        if bytes.len() != asset.size || documents::hash(&bytes) != asset.sha256 {
                            return Err("附件资源校验失败，原件已保留".into());
                        }
                        self.copy_file(doc_path(&target, &asset.path), bytes)?;
                    }
                    self.copy_file(doc_path(&target, &doc.path), raw)?;
                }
                let docs = &mut self.node_mut(&target, &to)?.docs;
                if docs.iter().any(|current| current.path == doc.path) {
                    return Err("目标节点已挂载这个附件".into());
                }
                docs.push(doc);
                self.note("挂载现有附件", format!("{source_location} → {location}"));
            }
            Operation::DetachDocument {
                board,
                node_id,
                document_id,
            } => {
                let (key, id) = self.document_node(&board, &node_id)?;
                let node = self.node(&key, &id)?;
                let doc = find_doc(node, &document_id)?;
                let location = format!("{} / {}", self.node_trail(&key, node), doc.title);
                self.node_mut(&key, &id)?
                    .docs
                    .retain(|doc| doc_id(&doc.path) != document_id);
                self.check_nodes.insert((key, id));
                self.record("解除附件挂载", location, None, None, true);
            }
            Operation::ReorderDocuments {
                board,
                node_id,
                document_ids,
            } => {
                let (key, id) = self.document_node(&board, &node_id)?;
                let node = self.node(&key, &id)?;
                let location = self.node_trail(&key, node);
                let ordinary: Vec<_> = node
                    .docs
                    .iter()
                    .filter(|doc| doc.path != question_path(&id))
                    .collect();
                let order: BTreeSet<_> = document_ids.iter().collect();
                if order.len() != document_ids.len() || ordinary.len() != order.len() {
                    return Err("附件顺序需要列出每个附件且不能重复".into());
                }
                let before = describe_docs(ordinary.into_iter());
                let ordered = document_ids
                    .iter()
                    .map(|doc| find_doc(node, doc).cloned())
                    .collect::<Result<Vec<_>, _>>()?;
                let after = describe_docs(ordered.iter());
                let target = self.node_mut(&key, &id)?;
                target.docs.retain(|doc| doc.path == question_path(&id));
                target.docs.extend(ordered);
                self.record("调整附件顺序", location, Some(before), Some(after), false);
            }
            _ => return Err("该操作不受支持".into()),
        }
        Ok(())
    }

    fn document_node(
        &mut self,
        board: &BoardRef,
        reference: &str,
    ) -> Result<(BoardKey, String), String> {
        let key = self.board_key(board)?;
        let id = self.resolve(reference)?;
        self.node(&key, &id)?;
        Ok((key, id))
    }

    fn file(&mut self, path: &str) -> Result<Option<Vec<u8>>, String> {
        if let Some(bytes) = self.files.get(path) {
            return Ok(Some(bytes.clone()));
        }
        observe(self.root, &mut self.observed, path)
    }

    fn copy_file(&mut self, path: String, bytes: Vec<u8>) -> Result<(), String> {
        if let Some(old) = self.file(&path)? {
            if old != bytes {
                return Err("目标已有同名附件，内容不同，未覆盖原件".into());
            }
        } else {
            self.files.insert(path, bytes);
        }
        Ok(())
    }
}

fn describe_docs<'a>(docs: impl Iterator<Item = &'a DocRef>) -> String {
    docs.enumerate()
        .map(|(i, doc)| format!("{}. {}", i + 1, doc.title))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(in crate::workspace_ai) fn doc_id(path: &str) -> String {
    documents::hash(path.as_bytes())
}

pub(in crate::workspace_ai) fn find_doc<'a>(
    node: &'a BoardNode,
    id: &str,
) -> Result<&'a DocRef, String> {
    let doc = node
        .docs
        .iter()
        .find(|doc| doc_id(&doc.path) == id)
        .ok_or("附件不在指定节点中")?;
    if doc.path == question_path(&node.id) {
        return Err("请用节点的 summary 编辑完整问题".into());
    }
    let name = doc.path.strip_prefix("docs/").ok_or("附件路径无效")?;
    if name.is_empty()
        || name.len() > 200
        || name.contains(['/', '\\', ':'])
        || name.contains("..")
        || name.chars().any(char::is_control)
    {
        return Err("附件路径无效".into());
    }
    Ok(doc)
}

fn doc_path(key: &BoardKey, doc: &str) -> String {
    format!("{}/{}/{doc}", key.0, key.1)
}
