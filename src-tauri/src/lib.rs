mod commands;
mod ai;
mod config;
mod secrets;
mod storage;
mod sync;

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
    // 圆角需与前端 .board-surface 的 border-radius 一致（10px），否则背后这层原生
    // 玻璃材质仍是方角，会从窗口圆角缺口露出直角。
    const CORNER_RADIUS: f64 = 10.0;
    let opts = LiquidGlassOptions::new(NSGlassEffectViewStyle::Regular).radius(CORNER_RADIUS);
    if apply_liquid_glass(window, opts).is_err() {
        let _ = apply_vibrancy(
            window,
            NSVisualEffectMaterial::UnderWindowBackground,
            None,
            Some(CORNER_RADIUS),
        );
    }
}

/// 供前端调用：给「当前调用的窗口」应用 macOS 原生材质 + 圆角。
/// AI 窗 / 阅读窗在运行时由 JS 动态创建（decorations:false），需要它们创建后
/// 自行调用本命令，才能和主窗一样获得圆角与原生窗口阴影。非 macOS 为空操作。
#[tauri::command]
fn apply_window_corners(window: tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    apply_native_material(&window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// The preview must set the native builder field directly. Config/JS window
/// options do not reliably carry an absolute data directory through Tauri.
#[cfg(feature = "isolated-preview")]
fn preview_webview_directory() -> Result<std::path::PathBuf, std::io::Error> {
    let exe = std::env::current_exe()?;
    let parent = exe.parent().ok_or_else(|| std::io::Error::other("预览程序目录无效"))?;
    let directory = parent.join(".preview").join("webview");
    std::fs::create_dir_all(&directory)?;
    Ok(directory)
}

#[tauri::command]
async fn preview_window_open(app: tauri::AppHandle, options: tauri::utils::config::WindowConfig) -> Result<(), String> {
    #[cfg(feature = "isolated-preview")]
    {
        let valid_url = match &options.url {
            tauri::WebviewUrl::App(path) => {
                let url = path.to_string_lossy();
                (options.label.starts_with("ai-") && url.starts_with("index.html?ai=1&"))
                    || (options.label.starts_with("reader-") && url.starts_with("index.html?reader=1&"))
            }
            _ => false,
        };
        if !valid_url { return Err("预览窗口仅允许本地阅读和对话页面".into()); }
        tauri::WebviewWindowBuilder::from_config(&app, &options)
            .map_err(|e| e.to_string())?
            .data_directory(preview_webview_directory().map_err(|e| e.to_string())?)
            .build().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(feature = "isolated-preview"))]
    { let _ = (app, options); Err("仅隔离预览支持此命令".into()) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(feature = "isolated-preview")]
    let context = {
        let mut context = context;
        // Prevent even a transient default-profile WebView before setup runs.
        for window in &mut context.config_mut().app.windows { window.create = false; }
        context
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            #[cfg(feature = "isolated-preview")]
            {
                let options = _app.config().app.windows.iter().find(|w| w.label == "main")
                    .ok_or_else(|| std::io::Error::other("缺少预览主窗口配置"))?.clone();
                tauri::WebviewWindowBuilder::from_config(_app, &options)?
                    .data_directory(preview_webview_directory()?)
                    .build()?;
            }
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
            sync::sync_settings_get,
            sync::sync_settings_set,
            sync::sync_snapshot,
            sync::reading_position_get,
            sync::reading_position_set,
            sync::sync_apply,
            sync::sync_http,
            sync::chat_capture,
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
            commands::open_doc_external,
            commands::chats_read,
            commands::chats_write,
            commands::secret_set,
            commands::secret_get,
            commands::secret_delete,
            commands::secret_has,
            commands::search_all,
            commands::export_text,
            commands::export_binary,
            commands::snapshot_list,
            commands::snapshot_create,
            commands::snapshot_restore,
            commands::snapshot_delete,
            ai::ai_chat_stream,
            ai::ai_cancel,
            apply_window_corners,
            preview_window_open,
        ])
        .run(context)
        .expect("failed to launch Lumen");
}
