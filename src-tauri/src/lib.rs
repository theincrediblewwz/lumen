mod commands;
mod config;
mod storage;

/// 应用原生窗口材质（仅 macOS）：
/// - macOS 26+：Apple 原生 Liquid Glass（NSGlassEffectView）；
/// - 更旧的 macOS：回退到 Vibrancy（NSVisualEffectView 毛玻璃）。
///
/// Windows/Linux 刻意不使用原生材质：Win11 的 Mica 只会取桌面壁纸色、且聚焦/失焦
/// 变色，整窗观感不佳（详见 ADR-019）。这些平台走前端纯实色主题，稳定干净。
#[cfg(target_os = "macos")]
fn apply_native_material(window: &tauri::WebviewWindow) {
    use window_vibrancy::{
        apply_liquid_glass, apply_vibrancy, LiquidGlassOptions, NSGlassEffectViewStyle,
        NSVisualEffectMaterial,
    };
    let opts = LiquidGlassOptions::new(NSGlassEffectViewStyle::Regular).radius(0.0);
    if apply_liquid_glass(window, opts).is_err() {
        let _ = apply_vibrancy(
            window,
            NSVisualEffectMaterial::UnderWindowBackground,
            None,
            None,
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    apply_native_material(&window);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::config_get,
            commands::config_set_storage_root,
            commands::projects_list,
            commands::project_create,
            commands::project_delete,
            commands::project_rename,
            commands::boards_list,
            commands::board_create,
            commands::board_load,
            commands::board_save,
            commands::board_delete,
            commands::board_rename,
            commands::docs_list,
            commands::doc_import,
            commands::doc_write,
            commands::doc_read,
            commands::doc_delete,
        ])
        .run(tauri::generate_context!())
        .expect("failed to launch Lumen");
}

