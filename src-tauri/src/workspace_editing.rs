//! User-authored Markdown, question documents and offline canvas images.
use crate::{board_operations, commands, documents, storage, sync};
use std::{collections::BTreeMap, fs, path::Path};
use base64::Engine;

fn prune_history(root:&Path,p:&str,b:&str,path:&str){
    let Ok(folder)=board_operations::checked_path(root,&format!("{p}/{b}/.document-history/{}",documents::hash(path.as_bytes()))) else{return;};
    if let Ok(entries)=fs::read_dir(folder){
        let mut entries=entries.flatten().filter(|e|e.file_name()!="original.md").collect::<Vec<_>>();
        entries.sort_by_key(|e|std::cmp::Reverse(e.metadata().and_then(|m|m.modified()).ok()));
        for entry in entries.into_iter().skip(19){let _=fs::remove_file(entry.path());}
    }
}

pub fn save_board(root: &Path, source: &storage::BoardFile) -> Result<(),String> {
    let p=storage::safe_id(&source.project_id)?;let b=storage::safe_id(&source.id)?;
    let mut board=source.clone();board.extra.remove("_disk_revision");board.version=storage::FORMAT_VERSION;board.updated_at=storage::now_iso();
    let original=storage::load_board(root,p,b)?;
    let (mut files, changed_questions) = prepare_questions(root, &mut board, &original.nodes)?;
    files.insert(format!("{p}/{b}/board.json"),serde_json::to_vec_pretty(&board).map_err(|e|e.to_string())?);
    sync::transaction(root,files)?;
    for path in changed_questions{prune_history(root,p,b,&path);}
    Ok(())
}

pub(crate) fn prepare_questions(root: &Path, board: &mut storage::BoardFile, original: &[storage::BoardNode]) -> Result<(BTreeMap<String, Vec<u8>>, Vec<String>), String> {
    let p=storage::safe_id(&board.project_id)?;let b=storage::safe_id(&board.id)?;
    let previous=original.iter().map(|n|(n.id.as_str(),n)).collect::<BTreeMap<_,_>>();
    let mut files=BTreeMap::new();
    let mut changed_questions=Vec::new();
    for node in &mut board.nodes {
        storage::safe_id(&node.id)?;
        let path=format!("docs/question_{}.md",node.id);
        let old=previous.get(node.id.as_str()).copied();
        let had_document=old.is_some_and(|n|n.docs.iter().any(|d|d.path==path));
        let requested=node.docs.iter().any(|d|d.path==path);
        let changed=old.map(|n|n.summary!=node.summary).unwrap_or(node.summary.is_some());
        // Viewing/panning a legacy graph must not create or read thousands of documents.
        if !changed&&!had_document&&!requested {continue;}
        let content=node.summary.as_deref().unwrap_or("");
        if content.len()>documents::LIMIT{return Err("问题文档超过32MiB，当前编辑保留".into());}
        if changed||!had_document {
            let target=documents::doc_path(root,p,b,&path)?;
            if target.exists(){
                let before=fs::read(&target).map_err(|e|e.to_string())?;
                if before!=content.as_bytes(){
                    if !had_document || old.and_then(|n|n.summary.as_deref()).unwrap_or("").as_bytes()!=before {
                        return Err("问题Markdown已在外部更改，当前编辑保留，请先合并原文".into());
                    }
                    let history=format!("{p}/{b}/.document-history/{}",documents::hash(path.as_bytes()));
                    if !board_operations::checked_path(root,&format!("{history}/original.md"))?.exists(){files.insert(format!("{history}/original.md"),before.clone());}
                    files.insert(format!("{history}/{}.md",documents::hash(&before)),before);
                    changed_questions.push(path.clone());
                    files.insert(format!("{p}/{b}/{path}"),content.as_bytes().to_vec());
                }
            }else{files.insert(format!("{p}/{b}/{path}"),content.as_bytes().to_vec());}
        }
        let reference=storage::DocRef{path:path.clone(),title:"完整问题".into(),bytes:Some(content.len() as u64),image_display:None};
        if let Some(old)=node.docs.iter_mut().find(|d|d.path==path){*old=reference;}else{node.docs.push(reference);}
    }
    Ok((files, changed_questions))
}

pub fn update_at(root:&Path,p:&str,b:&str,path:&str,content:&str,expected:&str)->Result<documents::Payload,String>{
    if content.len()>documents::LIMIT {return Err("Markdown最多32MiB".into());}
    let target=documents::doc_path(root,p,b,path)?;
    if !path.ends_with(".md") && !path.ends_with(".markdown") {return Err("只能编辑Markdown文档".into());}
    let raw=String::from_utf8(fs::read(&target).map_err(|e|e.to_string())?).map_err(|_|"请先将非UTF-8文档另存为UTF-8，原件保留")?;
    let files = prepare_markdown_update(root, p, b, path, &raw, content, expected)?;
    if !files.is_empty() {
        sync::transaction(root,files)?;
        // One immutable first version and at most 19 recent edit versions per document.
        prune_history(root,p,b,path);
    }
    documents::read_payload(root,p,b,path)
}

pub(crate) fn prepare_markdown_update(root:&Path,p:&str,b:&str,path:&str,raw:&str,content:&str,expected:&str)->Result<BTreeMap<String, Vec<u8>>,String>{
    if content.len()>documents::LIMIT {return Err("Markdown最多32MiB".into());}
    documents::doc_path(root,p,b,path)?;
    if !path.ends_with(".md") && !path.ends_with(".markdown") {return Err("只能编辑Markdown文档".into());}
    let (meta,body)=documents::split(raw)?;
    if meta.as_ref().is_some_and(|m|m.kind=="pdf"){return Err("PDF原件不能覆盖为Markdown".into());}
    if body==content {return Ok(BTreeMap::new());}
    if body!=expected {return Err("文档已被其他窗口修改，当前草稿已保留，请重新打开后合并".into());}
    let prefix=&raw[..raw.len()-body.len()];
    let history=format!("{p}/{b}/.document-history/{}",documents::hash(path.as_bytes()));
    let original=board_operations::checked_path(root,&format!("{history}/original.md"))?;
    let mut files=BTreeMap::from([
        (format!("{history}/{}.md",documents::hash(raw.as_bytes())),raw.as_bytes().to_vec()),
        (format!("{p}/{b}/{path}"),format!("{prefix}{content}").into_bytes()),
    ]);
    if !original.exists(){files.insert(format!("{history}/original.md"),raw.as_bytes().to_vec());}
    Ok(files)
}

#[tauri::command]
pub fn document_update(project_id:String,board_id:String,path:String,content:String,expected_content:String,expected_scope:String)->Result<documents::Payload,String>{
    let _guard=sync::IO_LOCK.lock().map_err(|e|e.to_string())?;let root=commands::root()?;
    board_operations::ensure_scope(&root,&expected_scope)?;
    update_at(&root,&project_id,&board_id,&path,&content,&expected_content)
}

#[tauri::command]
pub fn image_document(project_id:String,board_id:String,src_path:Option<String>,base64_data:Option<String>,expected_scope:String)->Result<storage::DocRef,String>{
    let _guard=sync::IO_LOCK.lock().map_err(|e|e.to_string())?;let root=commands::root()?;
    board_operations::ensure_scope(&root,&expected_scope)?;storage::safe_id(&project_id)?;storage::safe_id(&board_id)?;
    let bytes=if let Some(path)=src_path {documents::image_source(Path::new(&path))?}
      else {let encoded=base64_data.ok_or("请选择或粘贴图片")?;if encoded.len()>24*1024*1024{return Err("贴图最多16MiB".into());}base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_|"图片编码无效")?};
    let prepared=documents::prepare_image(bytes,"贴图".into())?;
    storage::load_board(&root,&project_id,&board_id)?;
    let mut files=BTreeMap::new();
    for(path,bytes)in prepared.files {
        let target=documents::doc_path(&root,&project_id,&board_id,&path)?;
        if target.exists(){if fs::read(target).map_err(|e|e.to_string())?!=bytes{return Err("已有同名图片校验失败，未覆盖".into());}}
        else{files.insert(format!("{project_id}/{board_id}/{path}"),bytes);}
    }
    sync::transaction(&root,files)?;Ok(prepared.reference)
}

/// Prepare the exporter's original ZIP/Markdown as an immutable mounted resource.
#[tauri::command]
pub fn document_import(project_id:String,board_id:String,src_path:String,expected_scope:String)->Result<storage::DocRef,String>{
    let _guard=sync::IO_LOCK.lock().map_err(|e|e.to_string())?;let root=commands::root()?;
    board_operations::ensure_scope(&root,&expected_scope)?;
    import_at(&root,&project_id,&board_id,Path::new(&src_path))
}
pub fn import_at(root:&Path,p:&str,b:&str,source:&Path)->Result<storage::DocRef,String>{
    storage::load_board(root,p,b)?;
    let prepared=documents::prepare(source,"","",0)?;let mut files=BTreeMap::new();
    for(path,bytes)in prepared.files{
        let target=documents::doc_path(root,p,b,&path)?;
        if target.exists(){if fs::read(target).map_err(|e|e.to_string())?!=bytes{return Err("已有资源校验失败，未覆盖原件".into());}}
        else{files.insert(format!("{p}/{b}/{path}"),bytes);}
    }
    sync::transaction(root,files)?;Ok(prepared.reference)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup()->(std::path::PathBuf,storage::BoardFile){
        let root=std::env::temp_dir().join(storage::new_id("editing_test"));storage::ensure_storage(&root).unwrap();
        let p=storage::create_project(&root,"测试").unwrap();let b=storage::create_board(&root,&p.id,"测试白板").unwrap();
        (root.clone(),storage::load_board(&root,&p.id,&b.id).unwrap())
    }
    #[test]
    fn question_markdown_and_presentation_survive_disk_and_clearing(){
        let(root,mut b)=setup();
        let mut n:storage::BoardNode=serde_json::from_value(serde_json::json!({"id":"n1","title":"\\nu","summary":"# 问题\r\n\r\n$\\nu$  \r\n","x":1,"y":2,"w":400,"h":270,"sticker":false,"docs":[],"created_at":"","updated_at":""})).unwrap();
        b.nodes.push(n.clone());b.extra.insert("appearance".into(),serde_json::json!({"fontFamily":"serif","fontSize":23,"zoomSensitivity":0.75}));
        save_board(&root,&b).unwrap();let loaded=storage::load_board(&root,&b.project_id,&b.id).unwrap();
        assert_eq!(loaded.nodes[0].extra["h"],270);assert_eq!(loaded.extra["appearance"]["fontSize"],23);assert_eq!(loaded.extra["appearance"]["zoomSensitivity"],0.75);
        assert_eq!(fs::read_to_string(documents::doc_path(&root,&b.project_id,&b.id,"docs/question_n1.md").unwrap()).unwrap(),n.summary.clone().unwrap());
        assert_eq!(loaded.nodes[0].docs[0].path,"docs/question_n1.md");n.summary=None;b.nodes=vec![n];save_board(&root,&b).unwrap();
        assert_eq!(documents::read_payload(&root,&b.project_id,&b.id,"docs/question_n1.md").unwrap().markdown,"");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn markdown_edit_uses_compare_and_swap_and_keeps_original_rollback(){
        let(root,b)=setup();let d=storage::write_doc(&root,&b.project_id,&b.id,"笔记","original\r\n").unwrap();
        update_at(&root,&b.project_id,&b.id,&d.path,"# 新内容\n\n$\\nu$","original\r\n").unwrap();
        assert!(update_at(&root,&b.project_id,&b.id,&d.path,"# 新内容\n\n$\\nu$","original\r\n").is_ok());
        assert!(update_at(&root,&b.project_id,&b.id,&d.path,"wrong","original\r\n").is_err());
        assert_eq!(documents::read_payload(&root,&b.project_id,&b.id,&d.path).unwrap().markdown,"# 新内容\n\n$\\nu$");
        let backup=root.join(format!("{}/{}/.document-history/{}/original.md",b.project_id,b.id,documents::hash(d.path.as_bytes())));
        assert_eq!(fs::read_to_string(backup).unwrap(),"original\r\n");
        assert!(update_at(&root,&b.project_id,&b.id,"docs/../../index.json","bad","").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn viewing_a_legacy_graph_does_not_materialize_every_question(){
        let(root,mut b)=setup();
        b.nodes=(0..1000).map(|i|serde_json::from_value(serde_json::json!({"id":format!("n{i}"),"title":"问题","summary":"旧问题","x":i,"y":0,"w":240,"docs":[],"created_at":"","updated_at":""})).unwrap()).collect();
        storage::save_board(&root,&b).unwrap();
        let board_path = storage::board_file(&root, &b.project_id, &b.id);
        let original: serde_json::Value = serde_json::from_slice(&fs::read(&board_path).unwrap()).unwrap();
        let mut sizes = Vec::new();
        for x in 100..110 {
            b.viewport = storage::Viewport { x: x as f64, y: 200.0, zoom: 0.76 };
            save_board(&root, &b).unwrap();
            let bytes = fs::read(&board_path).unwrap();
            sizes.push(bytes.len());
            let saved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(saved["viewport"]["x"].as_f64(), Some(x as f64));
            assert_eq!(saved["nodes"], original["nodes"]);
            assert_eq!(saved["edges"], original["edges"]);
        }
        assert!(sizes.windows(2).all(|pair| pair[0] == pair[1]));
        assert!(!root.join(".lumen-sync/pending.json").exists());
        assert_eq!(fs::read_dir(storage::docs_dir(&root,&b.project_id,&b.id)).unwrap().count(),0);
        b.nodes[0].summary=Some("编辑后的问题".into());save_board(&root,&b).unwrap();
        assert_eq!(fs::read_dir(storage::docs_dir(&root,&b.project_id,&b.id)).unwrap().count(),1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn external_question_edits_are_not_silently_overwritten(){
        let(root,mut b)=setup();b.nodes.push(serde_json::from_value(serde_json::json!({"id":"n1","title":"问题","summary":"first","x":0,"y":0,"w":240,"docs":[],"created_at":"","updated_at":""})).unwrap());save_board(&root,&b).unwrap();
        let mut b=storage::load_board(&root,&b.project_id,&b.id).unwrap();let path=documents::doc_path(&root,&b.project_id,&b.id,"docs/question_n1.md").unwrap();fs::write(&path,"external").unwrap();b.nodes[0].summary=Some("local".into());
        assert!(save_board(&root,&b).is_err());assert_eq!(fs::read_to_string(path).unwrap(),"external");assert_eq!(storage::load_board(&root,&b.project_id,&b.id).unwrap().nodes[0].summary.as_deref(),Some("first"));fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn sticker_bundle_preserves_pixels_when_markdown_is_edited_and_exported(){
        let(root,b)=setup();let hex="89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6350ea38f31f0004bc02762da7ade00000000049454e44ae426082";
        let png=(0..hex.len()).step_by(2).map(|i|u8::from_str_radix(&hex[i..i+2],16).unwrap()).collect::<Vec<_>>();
        let prep=documents::prepare_image(png.clone(),"图".into()).unwrap();let path=prep.reference.path;
        for(p,bytes)in prep.files{let target=documents::doc_path(&root,&b.project_id,&b.id,&p).unwrap();fs::write(target,bytes).unwrap();}
        let old=documents::read_payload(&root,&b.project_id,&b.id,&path).unwrap();
        let new=format!("# 编辑后的图文\n\n{}",old.markdown);update_at(&root,&b.project_id,&b.id,&path,&new,&old.markdown).unwrap();
        let after=documents::read_payload(&root,&b.project_id,&b.id,&path).unwrap();let asset=after.attachment.unwrap().images.into_values().next().unwrap();
        assert_eq!(documents::verified_asset(&root,&b.project_id,&b.id,&asset).unwrap(),png);
        let output=root.with_extension("edited.zip");documents::export_at(&root,&b.project_id,&b.id,&path,output.to_str().unwrap()).unwrap();
        let entries=documents::unzip(&fs::read(&output).unwrap()).unwrap();assert_eq!(entries["answer.md"],new.as_bytes());assert_eq!(entries["images/image.png"],png);fs::remove_file(output).unwrap();
        assert!(documents::prepare_image(b"<svg onload=evil()>".to_vec(),"bad".into()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn editor_refuses_symlink_document_without_modifying_its_target(){
        let(root,b)=setup();let outside=root.join("original.txt");fs::write(&outside,"protected").unwrap();
        let link=storage::docs_dir(&root,&b.project_id,&b.id).join("link.md");std::os::unix::fs::symlink(&outside,&link).unwrap();
        assert!(update_at(&root,&b.project_id,&b.id,"docs/link.md","overwrite","protected").is_err());assert_eq!(fs::read_to_string(outside).unwrap(),"protected");fs::remove_dir_all(root).unwrap();
    }
}
