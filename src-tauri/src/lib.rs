mod commands;
mod config;
mod storage;

/// 应用原生窗口材质：
/// - macOS 26+：Apple 原生 Liquid Glass（NSGlassEffectView）；更旧的 macOS 回退到
///   Vibrancy（NSVisualEffectView 毛玻璃）。
/// - Windows 11：Mica；失败则回退 Acrylic。
/// 任何一步失败都不影响应用启动（前端仍有 CSS 玻璃兜底）。
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn apply_native_material(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{
            apply_liquid_glass, apply_vibrancy, LiquidGlassOptions, NSGlassEffectViewStyle,
            NSVisualEffectMaterial,
        };
        // 先试 macOS 26+ 的液态玻璃；不支持则退回 vibrancy 毛玻璃。
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

    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, apply_mica};
        // Win11 优先 Mica，失败退回 Acrylic。
        if apply_mica(window, None).is_err() {
            let _ = apply_acrylic(window, None);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to launch Lumen");
}
