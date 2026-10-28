//! Rich documents keep a Markdown entry point and immutable, hash-bound originals.
use crate::{board_operations, commands, storage, sync};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

pub const PREFIX: &str = "<!-- lumen-document/v1\n";
const END: &str = "\n-->\n\n";
pub const LIMIT: usize = 32 * 1024 * 1024;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn read_source(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(err)?;
    let meta = file.metadata().map_err(err)?;
    if !meta.is_file() || meta.len() > LIMIT as u64 {
        return Err("请选择32MiB以内的普通文档文件".into());
    }
    let mut bytes = Vec::new();
    file.take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > LIMIT {
        return Err("源文件超过32MiB，未导入".into());
    }
    Ok(bytes)
}
pub fn hash(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    pub path: String,
    pub sha256: String,
    pub size: usize,
    pub media_type: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub schema: String,
    pub kind: String,
    pub original: Asset,
    #[serde(default)]
    pub images: BTreeMap<String, Asset>,
    #[serde(default)]
    pub pages: usize,
    #[serde(default)]
    pub extraction: String,
}
#[derive(Serialize)]
pub struct Payload {
    pub markdown: String,
    pub attachment: Option<Metadata>,
    pub scope: String,
}
pub fn asset_path(path: &str) -> Result<(), String> {
    let name = path.strip_prefix("docs/asset_").ok_or("附件路径无效")?;
    let (digest, ext) = name.split_once('.').ok_or("附件扩展名缺失")?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        || !matches!(ext, "pdf" | "zip" | "png" | "jpg" | "gif" | "webp")
    {
        return Err("附件路径无效".into());
    }
    Ok(())
}
pub fn assets(meta: &Metadata) -> impl Iterator<Item = &Asset> {
    std::iter::once(&meta.original).chain(meta.images.values())
}
pub fn split(raw: &str) -> Result<(Option<Metadata>, &str), String> {
    let Some(rest) = raw.strip_prefix(PREFIX) else {
        return Ok((None, raw));
    };
    let (header, body) = rest.split_once(END).ok_or("附件清单不完整；原件已保留")?;
    if header.len() > 512 * 1024 {
        return Err("附件清单过大".into());
    }
    let meta: Metadata = serde_json::from_str(header).map_err(|_| "附件清单损坏；原件已保留")?;
    if meta.schema != "lumen-document/v1"
        || !matches!(meta.kind.as_str(), "pdf" | "markdown_bundle")
        || meta.images.len() > 256
    {
        return Err("不支持的附件清单".into());
    }
    for asset in assets(&meta) {
        asset_path(&asset.path)?;
        let extension = asset.path.rsplit('.').next().unwrap_or("");
        let mime = match extension {
            "pdf" => "application/pdf",
            "zip" => "application/zip",
            "png" => "image/png",
            "jpg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "",
        };
        if asset.media_type != mime {
            return Err("附件 MIME 与文件类型不符".into());
        }
        if asset.size > LIMIT || !asset.path.contains(&format!("asset_{}.", asset.sha256)) {
            return Err("附件校验信息不符".into());
        }
    }
    if meta.images.iter().any(|(alias, asset)| {
        !alias.starts_with("images/")
            || alias.contains(['\\', ':'])
            || alias.chars().any(|c| c.is_control())
            || alias.split('/').any(|c| c == ".." || c == ".")
            || !asset.media_type.starts_with("image/")
    }) {
        return Err("图片别名无效".into());
    }
    if meta.kind == "pdf"
        && (!meta.original.path.ends_with(".pdf") || meta.original.media_type != "application/pdf")
        || meta.kind == "markdown_bundle"
            && (!meta.original.path.ends_with(".zip")
                || meta.original.media_type != "application/zip")
    {
        return Err("附件类型不符".into());
    }
    Ok((Some(meta), body))
}
pub fn doc_path(root: &Path, p: &str, b: &str, path: &str) -> Result<PathBuf, String> {
    storage::safe_id(p)?;
    storage::safe_id(b)?;
    let name = path.strip_prefix("docs/").ok_or("文档路径无效")?;
    if name.is_empty()
        || name.len() > 200
        || name.contains(['/', '\\', ':'])
        || name.contains("..")
        || name.chars().any(|c| c.is_control())
    {
        return Err("文档路径无效".into());
    }
    board_operations::checked_path(root, &format!("{p}/{b}/{path}"))
}
pub fn read_payload(root: &Path, p: &str, b: &str, path: &str) -> Result<Payload, String> {
    let raw = storage::decode_text(&fs::read(doc_path(root, p, b, path)?).map_err(err)?);
    let (attachment, body) = split(&raw)?;
    Ok(Payload {
        markdown: body.into(),
        attachment,
        scope: board_operations::scope(root)?,
    })
}
pub fn verified_asset(root: &Path, p: &str, b: &str, asset: &Asset) -> Result<Vec<u8>, String> {
    asset_path(&asset.path)?;
    let path = doc_path(root, p, b, &asset.path)?;
    if fs::metadata(&path).map_err(err)?.len() != asset.size as u64 {
        return Err("附件大小校验失败，请从备份恢复原件".into());
    }
    let bytes = fs::read(path).map_err(err)?;
    if hash(&bytes) != asset.sha256 {
        return Err("附件哈希校验失败，请从备份恢复原件".into());
    }
    Ok(bytes)
}
pub fn dependencies(bytes: &[u8]) -> Result<Vec<Asset>, String> {
    let raw = storage::decode_text(bytes);
    let (meta, _) = split(&raw)?;
    Ok(meta
        .as_ref()
        .map(|m| assets(m).cloned().collect())
        .unwrap_or_default())
}
fn make_asset(
    bytes: Vec<u8>,
    ext: &str,
    mime: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Asset {
    let sha256 = hash(&bytes);
    let path = format!("docs/asset_{sha256}.{ext}");
    let size = bytes.len();
    files.insert(path.clone(), bytes);
    Asset {
        path,
        sha256,
        size,
        media_type: mime.into(),
    }
}
fn image_type(bytes: &[u8]) -> Result<(&'static str, &'static str), String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(("png", "image/png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok(("gif", "image/gif"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Ok(("webp", "image/webp"))
    } else {
        Err("ZIP 含无效图片；仅支持 PNG/JPEG/GIF/WebP".into())
    }
}
pub fn unzip(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    unzip_limit(bytes, LIMIT, 512)
}
pub fn unzip_limit(
    bytes: &[u8],
    limit: usize,
    count: usize,
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("ZIP 无法读取：{e}"))?;
    if archive.len() > count {
        return Err("ZIP 文件数量超过处理预算".into());
    }
    let mut result = BTreeMap::new();
    let mut total = 0usize;
    let mut names = BTreeSet::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(err)?;
        let name = file.name().map_err(err)?.into_owned();
        if name.len() > 240
            || name.contains(['\\', ':', '\0'])
            || name.starts_with('/')
            || name.split('/').any(|c| c == ".." || c == ".")
            || file.enclosed_name().is_none()
            || file.is_symlink()
            || file.encrypted()
            || !names.insert(name.nfc().flat_map(char::to_lowercase).collect::<String>())
        {
            return Err("ZIP 含不安全、重复或加密的文件路径".into());
        }
        if file.is_dir() {
            continue;
        }
        total = total
            .checked_add(usize::try_from(file.size()).map_err(err)?)
            .ok_or("ZIP 过大")?;
        if total > limit {
            return Err("ZIP 解压内容超过处理预算".into());
        }
        let mut data = Vec::new();
        (&mut file)
            .take((limit + 1) as u64)
            .read_to_end(&mut data)
            .map_err(err)?;
        if data.len() > limit || data.len() as u64 != file.size() {
            return Err("ZIP 文件大小不符".into());
        }
        result.insert(name, data);
    }
    Ok(result)
}
pub struct Prepared {
    pub reference: storage::DocRef,
    pub files: BTreeMap<String, Vec<u8>>,
}
pub fn prepare(
    src: &Path,
    expected_hash: &str,
    pdf_text: &str,
    pages: usize,
) -> Result<Prepared, String> {
    if fs::metadata(src).map_err(err)?.len() > LIMIT as u64 {
        return Err("单个附件最多32MiB".into());
    }
    let raw = read_source(src)?;
    let digest = hash(&raw);
    if !expected_hash.is_empty() && digest != expected_hash {
        return Err("源文件在读取后发生变化，请重新导入".into());
    }
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let title = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("文档")
        .chars()
        .take(180)
        .collect::<String>();
    let mut files = BTreeMap::new();
    let content = match ext.as_str() {
        "md" | "markdown" => {
            let text = storage::decode_text(&raw);
            if text.starts_with(PREFIX) {
                return Err("独立导入请使用原始 PDF/ZIP，或完整白板资料包".into());
            }
            text
        }
        "pdf" => {
            if !raw.starts_with(b"%PDF-") || pages > 2000 || pdf_text.len() > 8 * 1024 * 1024 {
                return Err("PDF 无效或超过提取预算".into());
            }
            let original = make_asset(raw, "pdf", "application/pdf", &mut files);
            let extraction = if pages == 0 {
                "unavailable"
            } else if pdf_text.trim().is_empty() {
                "empty"
            } else {
                "ready"
            };
            let meta = Metadata {
                schema: "lumen-document/v1".into(),
                kind: "pdf".into(),
                original,
                images: BTreeMap::new(),
                pages,
                extraction: extraction.into(),
            };
            let body = if extraction != "ready" {
                format!("# {title}\n\nPDF 原件已保存。暂未提取到可检索文字；请打开 PDF 阅读图片与排版。AI 无法读取其中的图片内容。\n")
            } else {
                pdf_text.into()
            };
            format!(
                "{PREFIX}{}{END}{body}",
                serde_json::to_string(&meta).map_err(err)?
            )
        }
        "zip" => {
            let mut entries = unzip(&raw)?;
            let primary = if entries.contains_key("answer.md") {
                "answer.md".to_string()
            } else {
                let candidates = entries
                    .keys()
                    .filter(|p| {
                        !p.contains('/')
                            && p.to_lowercase().ends_with(".md")
                            && p.as_str() != "EXPORT-NOTES.md"
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if candidates.len() != 1 {
                    return Err(
                        "请选择包含 answer.md 和 images/ 的 Markdown 图片包；应用安装包不能挂载"
                            .into(),
                    );
                }
                candidates[0].clone()
            };
            let text = String::from_utf8(entries.remove(&primary).unwrap())
                .map_err(|_| "ZIP 正文必须为 UTF-8 Markdown")?;
            if text.starts_with(PREFIX) {
                return Err("ZIP 正文不能嵌套附件清单".into());
            }
            let original = make_asset(raw, "zip", "application/zip", &mut files);
            let mut images = BTreeMap::new();
            for (name, bytes) in entries {
                if name == "EXPORT-NOTES.md" {
                    continue;
                }
                if !name.starts_with("images/") {
                    return Err(format!("图片包含不支持的文件：{name}"));
                }
                let (ext, mime) = image_type(&bytes)?;
                let asset = make_asset(bytes, ext, mime, &mut files);
                images.insert(name, asset);
            }
            let meta = Metadata {
                schema: "lumen-document/v1".into(),
                kind: "markdown_bundle".into(),
                original,
                images,
                pages: 0,
                extraction: "ready".into(),
            };
            format!(
                "{PREFIX}{}{END}{text}",
                serde_json::to_string(&meta).map_err(err)?
            )
        }
        _ => return Err("请选择 Markdown、PDF 或 Markdown 图片 ZIP".into()),
    };
    let path = format!("docs/import_{digest}.md");
    let bytes = content.len() as u64;
    split(&content)?; // A writer must never emit metadata that the reader rejects.
    files.insert(path.clone(), content.into_bytes());
    Ok(Prepared {
        reference: storage::DocRef {
            path,
            title,
            bytes: Some(bytes),
        },
        files,
    })
}
pub fn attach_at(
    root: &Path,
    p: &str,
    b: &str,
    node_id: &str,
    revision: &str,
    prepared: Prepared,
    keep: usize,
) -> Result<storage::BoardFile, String> {
    if sync::board_revision(root, p, b)? != revision {
        return Err("白板已变化，附件尚未挂载，请重试".into());
    }
    let mut board = storage::load_board(root, p, b)?;
    let node = board
        .nodes
        .iter_mut()
        .find(|n| n.id == node_id)
        .ok_or("目标节点已不存在，未导入")?;
    if node.docs.iter().any(|d| d.path == prepared.reference.path) {
        return Ok(board);
    }
    let mut files = BTreeMap::new();
    let base = format!("{p}/{b}");
    for (path, bytes) in prepared.files {
        let target = doc_path(root, p, b, &path)?;
        if target.exists() {
            if !target.is_file() {
                return Err("文档路径被目录占用，未导入".into());
            }
            if path == prepared.reference.path {
                continue;
            }
            if fs::read(target).map_err(err)? != bytes {
                return Err("已有同名附件损坏，未覆盖原件".into());
            }
        } else {
            files.insert(format!("{base}/{path}"), bytes);
        }
    }
    node.docs.push(prepared.reference);
    node.updated_at = storage::now_iso();
    board.updated_at = node.updated_at.clone();
    let (name, backup) = board_operations::backup_at(root, p, b, "挂载文档前")?;
    files.insert(format!("{base}/.ai-backups/{name}"), backup);
    files.insert(
        format!("{base}/board.json"),
        serde_json::to_vec_pretty(&board).map_err(err)?,
    );
    sync::transaction(root, files)?;
    let _ = board_operations::prune(root, p, b, keep);
    Ok(board)
}

#[tauri::command]
pub async fn attachment_source(src_path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&src_path);
        if path
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|s| !s.eq_ignore_ascii_case("pdf"))
            || fs::metadata(path).map_err(err)?.len() > LIMIT as u64
        {
            return Err("请选择32MiB以内的 PDF".into());
        }
        let bytes = read_source(path)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn attachment_attach(
    project_id: String,
    board_id: String,
    node_id: String,
    src_path: String,
    source_hash: String,
    pdf_text: String,
    pages: usize,
    expected_revision: String,
    expected_scope: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(Path::new(&src_path), &source_hash, &pdf_text, pages)?;
        let _guard = sync::IO_LOCK.lock().map_err(err)?;
        let root = commands::root()?;
        board_operations::ensure_scope(&root, &expected_scope)?;
        let keep = board_operations::policy_at(&crate::config::config_dir()?)?.keep;
        let board = attach_at(
            &root,
            &project_id,
            &board_id,
            &node_id,
            &expected_revision,
            prepared,
            keep,
        )?;
        let mut value = serde_json::to_value(board).map_err(err)?;
        value["_disk_revision"] =
            serde_json::json!(sync::board_revision(&root, &project_id, &board_id)?);
        Ok(value)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub fn document_payload(
    project_id: String,
    board_id: String,
    path: String,
    expected_scope: Option<String>,
) -> Result<Payload, String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    let root = commands::root()?;
    if let Some(s) = expected_scope {
        board_operations::ensure_scope(&root, &s)?;
    }
    read_payload(&root, &project_id, &board_id, &path)
}
#[tauri::command]
pub fn document_asset_read(
    project_id: String,
    board_id: String,
    path: String,
    asset_path: String,
    expected_scope: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    let root = commands::root()?;
    if let Some(s) = expected_scope {
        board_operations::ensure_scope(&root, &s)?;
    }
    let payload = read_payload(&root, &project_id, &board_id, &path)?;
    let meta = payload.attachment.ok_or("文档没有附件")?;
    let asset = assets(&meta)
        .find(|a| a.path == asset_path)
        .ok_or("此附件不属于当前文档")?;
    Ok(tauri::ipc::Response::new(verified_asset(
        &root,
        &project_id,
        &board_id,
        asset,
    )?))
}
#[tauri::command]
pub fn document_export(
    project_id: String,
    board_id: String,
    path: String,
    destination: String,
    expected_scope: String,
) -> Result<(), String> {
    let _g = sync::IO_LOCK.lock().map_err(err)?;
    let root = commands::root()?;
    board_operations::ensure_scope(&root, &expected_scope)?;
    export_at(&root, &project_id, &board_id, &path, &destination)
}
pub fn export_at(
    root: &Path,
    p: &str,
    b: &str,
    path: &str,
    destination: &str,
) -> Result<(), String> {
    let payload = read_payload(root, p, b, path)?;
    let (bytes, ext) = if let Some(meta) = payload.attachment {
        if meta.kind == "pdf" {
            (verified_asset(root, p, b, &meta.original)?, "pdf")
        } else {
            let mut entries = BTreeMap::from([("answer.md".into(), payload.markdown.into_bytes())]);
            for (alias, asset) in &meta.images {
                if !alias.starts_with("images/")
                    || alias.contains(['\\', ':'])
                    || alias.split('/').any(|s| s == ".." || s == ".")
                {
                    return Err("图片路径无效".into());
                }
                entries.insert(alias.clone(), verified_asset(root, p, b, asset)?);
            }
            (crate::portable_documents::archive(&entries)?, "zip")
        }
    } else {
        (fs::read(doc_path(root, p, b, path)?).map_err(err)?, "md")
    };
    if !Path::new(destination)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case(ext))
    {
        return Err(format!("请选择 .{ext} 文件"));
    }
    sync::atomic_bytes(
        &board_operations::external_destination(root, destination)?,
        &bytes,
    )
}
