use serde::Serialize;
use std::path::PathBuf;

fn starkeep_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let dir = home.join(".starkeep");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create ~/.starkeep: {e}"))?;
    Ok(dir)
}

#[derive(Serialize)]
pub struct CloudSetupState {
    pub state: String,
    pub has_credentials: bool,
}

#[tauri::command]
pub fn get_cloud_setup_state() -> Result<CloudSetupState, String> {
    let dir = starkeep_dir()?;
    let config_exists = dir.join("cloud-config.json").exists();
    let creds_exist = dir.join("cloud-credentials.json").exists();
    Ok(CloudSetupState {
        state: if config_exists { "configured".to_string() } else { "unconfigured".to_string() },
        has_credentials: creds_exist,
    })
}

#[tauri::command]
pub fn read_cloud_config() -> Result<Option<String>, String> {
    let path = starkeep_dir()?.join("cloud-config.json");
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read cloud-config.json: {e}"))?;
    Ok(Some(contents))
}

#[tauri::command]
pub fn write_cloud_config(config_json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&config_json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;
    let path = starkeep_dir()?.join("cloud-config.json");
    std::fs::write(&path, &config_json)
        .map_err(|e| format!("Cannot write cloud-config.json: {e}"))
}

#[tauri::command]
pub fn read_cloud_credentials() -> Result<Option<String>, String> {
    let path = starkeep_dir()?.join("cloud-credentials.json");
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read cloud-credentials.json: {e}"))?;
    Ok(Some(contents))
}

#[tauri::command]
pub fn write_cloud_credentials(creds_json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&creds_json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;
    let path = starkeep_dir()?.join("cloud-credentials.json");
    std::fs::write(&path, &creds_json)
        .map_err(|e| format!("Cannot write cloud-credentials.json: {e}"))
}

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read file '{path}': {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}
