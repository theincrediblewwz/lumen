mod commands;
mod config;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::config_get,
            commands::config_set_storage_root,
            commands::projects_list,
            commands::project_create,
            commands::project_delete,
            commands::boards_list,
            commands::board_create,
            commands::board_load,
            commands::board_save,
            commands::board_delete,
        ])
        .run(tauri::generate_context!())
        .expect("failed to launch Lumen");
}
