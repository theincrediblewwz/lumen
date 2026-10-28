//! Exercise Tauri's generated native authority, rather than the browser's synthetic IPC.
use tauri::ipc::Origin;

#[test]
fn compiled_acl_allows_document_dialogs_in_local_app_windows() {
    let mut context = crate::application_context();
    let authority = context.runtime_authority_mut();
    for label in [
        "main",
        "reader-synthetic-doc",
        "ai-synthetic-board",
        "ai-synthetic-board-node",
    ] {
        for command in ["plugin:dialog|open", "plugin:dialog|save"] {
            assert!(
                authority
                    .resolve_access(command, label, label, &Origin::Local)
                    .is_some(),
                "{command} must be allowed by the compiled native ACL for {label}"
            );
        }
    }
}

#[test]
fn compiled_acl_does_not_grant_dialogs_to_unrelated_windows_or_remote_pages() {
    let mut context = crate::application_context();
    let authority = context.runtime_authority_mut();
    let remote = Origin::Remote {
        url: "https://synthetic.invalid/".parse().unwrap(),
    };
    for command in ["plugin:dialog|open", "plugin:dialog|save"] {
        assert!(authority
            .resolve_access(command, "unrelated", "unrelated", &Origin::Local)
            .is_none());
        for label in ["main", "reader-synthetic-doc", "ai-synthetic-board-node"] {
            assert!(authority
                .resolve_access(command, label, label, &remote)
                .is_none());
        }
    }
}

#[test]
fn public_share_readers_have_no_application_or_plugin_permissions() {
    let mut context=crate::application_context();
    let authority=context.runtime_authority_mut();
    for url in ["https://chat.deepseek.com/share/synthetic123","https://chatgpt.com/share/synthetic123","https://www.doubao.com/thread/synthetic123"] {
        let remote=Origin::Remote{url:url.parse().unwrap()};
        for command in ["secret_get","doc_read","board_save","board_operations_apply","conversation_import_apply","library_package_export","library_package_restore","plugin:dialog|open","plugin:webview|create_webview_window"] {
            assert!(authority.resolve_access(command,"share-read-synthetic","share-read-synthetic",&remote).is_none(),"{command} must remain unavailable to the public share page");
        }
    }
}

#[test]
fn compiled_acl_allows_background_chat_hide_only_for_local_app_windows() {
    let mut context=crate::application_context();
    let authority=context.runtime_authority_mut();
    for label in ["main","ai-synthetic-board","ai-synthetic-board-node"] {
        assert!(authority.resolve_access("plugin:window|hide",label,label,&Origin::Local).is_some());
        let remote=Origin::Remote{url:"https://synthetic.invalid/".parse().unwrap()};
        assert!(authority.resolve_access("plugin:window|hide",label,label,&remote).is_none());
    }
    assert!(authority.resolve_access("plugin:window|hide","share-read-synthetic","share-read-synthetic",&Origin::Local).is_none());
}
