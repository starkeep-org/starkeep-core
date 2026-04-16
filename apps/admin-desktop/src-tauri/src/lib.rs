mod commands;
mod db;

use db::AppDatabase;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");
            let database = AppDatabase::open(data_dir)
                .expect("failed to open database");
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_aws_settings,
            commands::save_aws_settings,
            commands::list_plans,
            commands::get_plan,
            commands::create_plan,
            commands::delete_plan,
            commands::get_deployment,
            commands::list_directory,
            commands::get_parent_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
