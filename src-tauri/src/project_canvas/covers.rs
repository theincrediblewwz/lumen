//! Optional desktop catalog artwork. IDs refer to bundled images.
use super::{require_board, require_project, MAX_FILE_BYTES};
use crate::{board_operations as safety, commands, storage, sync};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub(crate) const FILE: &str = "project-covers.json";
pub type CoverStore = BTreeMap<String, String>;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CoverTarget {
    Project { id: String },
    Board { project_id: String, id: String },
}

#[derive(Deserialize)]
struct Preset {
    id: String,
}

pub(crate) fn read(root: &Path) -> Result<CoverStore, String> {
    let path = safety::checked_path(root, FILE)?;
    if !path.exists() {
        return Ok(CoverStore::new());
    }
    if fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_FILE_BYTES
    {
        return Err("封面记录文件过大".into());
    }
    let covers: CoverStore =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("无法读取封面记录：{error}"))?;
    for (target, cover_id) in &covers {
        if let Some((project, board)) = target.split_once('/') {
            storage::safe_id(project)?;
            storage::safe_id(board)?;
        } else {
            storage::safe_id(target)?;
        }
        storage::safe_id(cover_id)?;
    }
    Ok(covers)
}

pub(crate) fn bytes(covers: &CoverStore) -> Result<Vec<u8>, String> {
    let content = serde_json::to_vec_pretty(covers).map_err(|error| error.to_string())?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("封面记录文件过大".into());
    }
    Ok(content)
}

pub(crate) fn retain(
    covers: &mut CoverStore,
    projects: &BTreeSet<String>,
    owners: &BTreeMap<String, String>,
) {
    covers.retain(|target, _| match target.split_once('/') {
        Some((project, board)) => owners.get(board).map(String::as_str) == Some(project),
        None => projects.contains(target),
    });
}

pub(super) fn assign(
    root: &Path,
    target: &CoverTarget,
    cover_id: Option<String>,
    expected_cover_id: Option<&str>,
) -> Result<CoverStore, String> {
    let index = storage::read_index(root)?;
    let key = match target {
        CoverTarget::Project { id } => {
            require_project(&index, id)?;
            id.clone()
        }
        CoverTarget::Board { project_id, id } => {
            require_board(root, &index, project_id, id)?;
            format!("{project_id}/{id}")
        }
    };
    if let Some(id) = &cover_id {
        let presets: Vec<Preset> =
            serde_json::from_str(include_str!("../../../src/projectCanvas/covers.json"))
                .map_err(|error| format!("内置封面库无法读取：{error}"))?;
        if !presets.iter().any(|preset| preset.id == *id) {
            return Err("封面已不在内置图库中".into());
        }
    }
    let mut covers = read(root)?;
    let current_cover_id = covers.get(&key).map(String::as_str);
    if current_cover_id == cover_id.as_deref() {
        return Ok(covers);
    }
    if current_cover_id != expected_cover_id {
        return Err("这个封面已在其他窗口更改，请关闭后重新选择".into());
    }
    match cover_id {
        Some(id) => {
            covers.insert(key, id);
        }
        None => {
            covers.remove(&key);
        }
    }
    sync::atomic_bytes(&safety::checked_path(root, FILE)?, &bytes(&covers)?)?;
    Ok(covers)
}

#[tauri::command]
pub fn project_canvas_cover(
    target: CoverTarget,
    cover_id: Option<String>,
    expected_cover_id: Option<String>,
    expected_scope: String,
) -> Result<CoverStore, String> {
    let _guard = sync::IO_LOCK.lock().map_err(|error| error.to_string())?;
    let root = commands::root()?;
    safety::ensure_scope(&root, &expected_scope)?;
    assign(&root, &target, cover_id, expected_cover_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library_package::{export_at, restore_at};
    use serde_json::{json, Value};
    use std::path::PathBuf;

    #[test]
    fn project_and_board_covers_save_and_reset_without_rewriting_content() {
        let root = std::env::temp_dir().join(storage::new_id("cover_test"));
        storage::ensure_storage(&root).unwrap();
        let project = storage::create_project(&root, "Research").unwrap();
        let other = storage::create_project(&root, "Other").unwrap();
        let board = storage::create_board(&root, &project.id, "Notes").unwrap();
        let doc =
            storage::write_doc(&root, &project.id, &board.id, "Original", "# Original\n").unwrap();
        let paths = [
            PathBuf::from("index.json"),
            PathBuf::from(&project.id).join("project.json"),
            PathBuf::from(&project.id)
                .join(&board.id)
                .join("board.json"),
            PathBuf::from(&project.id).join(&board.id).join(doc.path),
        ];
        let before = paths
            .each_ref()
            .map(|path| fs::read(root.join(path)).unwrap());
        let folder = CoverTarget::Project {
            id: project.id.clone(),
        };
        let tile = CoverTarget::Board {
            project_id: project.id.clone(),
            id: board.id.clone(),
        };
        let wrong_tile = CoverTarget::Board {
            project_id: other.id.clone(),
            id: board.id.clone(),
        };
        let key = format!("{}/{}", project.id, board.id);

        assert!(read(&root).unwrap().is_empty());
        assert!(!root.join(FILE).exists());
        assert!(assign(&root, &wrong_tile, Some("ink-rain".into()), None).is_err());
        assert!(assign(&root, &folder, Some("file:///elsewhere.jpg".into()), None).is_err());
        assign(&root, &folder, Some("reed-morning-mist".into()), None).unwrap();
        assign(&root, &tile, Some("ink-rain".into()), None).unwrap();
        assert!(assign(&root, &tile, Some("redwood-morning".into()), None).is_err());
        let saved = read(&root).unwrap();
        assert_eq!(saved[&project.id], "reed-morning-mist");
        assert_eq!(saved[&key], "ink-rain");
        assert_eq!(
            assign(&root, &tile, Some("ink-rain".into()), None).unwrap(),
            saved
        );
        assert_eq!(
            paths
                .each_ref()
                .map(|path| fs::read(root.join(path)).unwrap()),
            before
        );
        assert!(!root.join(super::super::FILE).exists());

        super::super::move_project(&root, &project.id, None, Some(other.id)).unwrap();
        assert_eq!(read(&root).unwrap(), saved);
        assign(&root, &tile, None, Some("ink-rain")).unwrap();
        assert_eq!(
            read(&root).unwrap(),
            BTreeMap::from([(project.id, "reed-morning-mist".into())])
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_and_library_packages_restore_their_own_cover_selections() {
        let root = std::env::temp_dir().join(storage::new_id("cover_package"));
        storage::ensure_storage(&root).unwrap();
        let project = storage::create_project(&root, "Project").unwrap();
        let child = super::super::create_child(&root, "Child", &project.id).unwrap();
        let board = storage::create_board(&root, &child.id, "Board").unwrap();
        let other = storage::create_project(&root, "Outside").unwrap();
        assign(
            &root,
            &CoverTarget::Project {
                id: project.id.clone(),
            },
            Some("ink-rain".into()),
            None,
        )
        .unwrap();
        assign(
            &root,
            &CoverTarget::Project {
                id: other.id.clone(),
            },
            Some("aurora-lake".into()),
            None,
        )
        .unwrap();
        assign(
            &root,
            &CoverTarget::Board {
                project_id: child.id.clone(),
                id: board.id.clone(),
            },
            Some("reed-morning-mist".into()),
            None,
        )
        .unwrap();
        let output = root.with_extension("archive");
        fs::create_dir(&output).unwrap();
        for (name, scope) in [
            ("project.zip", Some(project.id.as_str())),
            ("library.zip", None),
        ] {
            let archive = output.join(name);
            export_at(&root, scope, &archive, Value::Null, |_, _| {}).unwrap();
            let restored = restore_at(&archive, &output).unwrap();
            let actual = read(Path::new(restored["root"].as_str().unwrap())).unwrap();
            let mut expected = read(&root).unwrap();
            if scope.is_some() {
                expected.remove(&other.id);
            }
            assert_eq!(json!(actual), json!(expected));
        }
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(output).unwrap();
    }
}
