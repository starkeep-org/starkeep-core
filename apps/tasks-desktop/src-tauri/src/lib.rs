use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

/// Invoked by the webview to start an agentic chat session.
///
/// Spawns the Bun sidecar (`agent-sidecar`) with a single JSON argument
/// containing the session context. The sidecar streams `AgentEvent` JSON lines
/// to stdout; this handler reads them and re-emits each as a Tauri event
/// `agent_event:{session_id}` so the webview's `IpcChatTransport` can consume
/// them via `listen()`.
#[tauri::command]
async fn run_chat(
    app: tauri::AppHandle,
    session_id: String,
    messages: String,
    user_id: String,
    group_id: String,
) -> Result<(), String> {
    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| "ANTHROPIC_API_KEY environment variable is not set".to_string())?;

    // Resolve the app-local data directory so the sidecar can open the same
    // SQLite DB and objects directory that the Tauri SQL / FS plugins use.
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    let db_path = data_dir.join("tasks.db");
    let objects_path = data_dir.join("objects");

    let input = serde_json::json!({
        "sessionId": session_id,
        "messages": serde_json::from_str::<serde_json::Value>(&messages)
            .unwrap_or(serde_json::json!([])),
        "userId": user_id,
        "groupId": group_id,
        "dbPath": db_path.to_string_lossy(),
        "objectsPath": objects_path.to_string_lossy(),
        "anthropicApiKey": api_key,
    });

    let (mut rx, child) = app
        .shell()
        .sidecar("agent-sidecar")
        .map_err(|e| e.to_string())?
        .args([input.to_string()])
        .spawn()
        .map_err(|e| e.to_string())?;

    // Drive the sidecar on a background task so `run_chat` returns immediately
    // and the webview is not blocked while the agentic loop runs.
    tokio::spawn(async move {
        // Keep `child` alive for the duration of the task; dropping it would
        // kill the sidecar process before it finishes.
        let _child = child;

        let mut stdout_buf = String::new();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if let Ok(chunk) = String::from_utf8(bytes) {
                        stdout_buf.push_str(&chunk);
                        // Process every complete newline-delimited JSON line.
                        while let Some(pos) = stdout_buf.find('\n') {
                            let line = stdout_buf[..pos].trim().to_string();
                            stdout_buf = stdout_buf[pos + 1..].to_string();
                            if line.is_empty() {
                                continue;
                            }
                            if let Ok(val) =
                                serde_json::from_str::<serde_json::Value>(&line)
                            {
                                let _ = app.emit(
                                    &format!("agent_event:{session_id}"),
                                    val,
                                );
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Ok(text) = String::from_utf8(bytes) {
                        eprintln!("[agent-sidecar] {}", text.trim_end());
                    }
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
    });

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
