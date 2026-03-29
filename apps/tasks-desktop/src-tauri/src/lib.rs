use tauri::Emitter;

/// Invoked by the webview to start an agentic chat session.
/// The Rust side runs the Node.js sidecar which executes the agentic loop
/// and emits `agent_event:{sessionId}` Tauri events back to the webview.
#[tauri::command]
async fn run_chat(
    app: tauri::AppHandle,
    session_id: String,
    messages: String,
    user_id: String,
    group_id: String,
) -> Result<(), String> {
    // TODO: Spawn Node.js sidecar that runs `tasks-lib/src/ai/agentic-loop.ts`
    // The sidecar receives messages via stdin (JSON) and emits agent_event payloads
    // via Tauri's emit() API back to the window.
    //
    // Stub: emit a single done event so the UI doesn't hang during development.
    app.emit(&format!("agent_event:{session_id}"), serde_json::json!({ "type": "done" }))
        .map_err(|e: tauri::Error| e.to_string())?;
    let _ = (messages, user_id, group_id); // suppress unused warnings until sidecar is wired
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![run_chat])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
