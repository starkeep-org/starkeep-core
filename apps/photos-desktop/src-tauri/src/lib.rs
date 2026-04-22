mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_cloud_setup_state,
            commands::read_cloud_config,
            commands::write_cloud_config,
            commands::read_cloud_credentials,
            commands::write_cloud_credentials,
            commands::read_file_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
