use crate::db::{AppDatabase, AwsSettings, Deployment, Plan};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::State;

// --- AWS Settings ---

#[tauri::command]
pub fn get_aws_settings(db: State<'_, AppDatabase>) -> Result<Option<AwsSettings>, String> {
    db.get_aws_settings()
}

#[derive(Deserialize)]
pub struct SaveAwsSettingsInput {
    pub account_id: String,
    pub default_region: String,
    pub stack_prefix: String,
    pub role_arn: String,
    pub external_id: String,
    pub execution_role_arn: Option<String>,
    pub permission_boundary_arn: Option<String>,
}

#[tauri::command]
pub fn save_aws_settings(
    db: State<'_, AppDatabase>,
    input: SaveAwsSettingsInput,
) -> Result<AwsSettings, String> {
    let settings = AwsSettings {
        id: uuid::Uuid::new_v4().to_string(),
        account_id: input.account_id,
        default_region: input.default_region,
        stack_prefix: input.stack_prefix,
        role_arn: input.role_arn,
        external_id: input.external_id,
        execution_role_arn: input.execution_role_arn,
        permission_boundary_arn: input.permission_boundary_arn,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    db.save_aws_settings(&settings)?;
    Ok(settings)
}

// --- Plans ---

#[derive(Serialize)]
pub struct PlanWithDeployment {
    #[serde(flatten)]
    pub plan: Plan,
    pub latest_deployment: Option<Deployment>,
}

#[tauri::command]
pub fn list_plans(db: State<'_, AppDatabase>) -> Result<Vec<PlanWithDeployment>, String> {
    let plans = db.list_plans()?;
    let mut result = Vec::with_capacity(plans.len());
    for plan in plans {
        let deployment = db.get_latest_deployment(&plan.id)?;
        result.push(PlanWithDeployment {
            plan,
            latest_deployment: deployment,
        });
    }
    Ok(result)
}

#[tauri::command]
pub fn get_plan(db: State<'_, AppDatabase>, plan_id: String) -> Result<Option<Plan>, String> {
    db.get_plan(&plan_id)
}

#[derive(Deserialize)]
pub struct CreatePlanInput {
    pub stack_name: String,
    pub region: String,
    pub environment: Option<String>,
    pub template_type: Option<String>,
    pub parameters: Option<String>,
}

#[tauri::command]
pub fn create_plan(db: State<'_, AppDatabase>, input: CreatePlanInput) -> Result<Plan, String> {
    let plan = Plan {
        id: uuid::Uuid::new_v4().to_string(),
        stack_name: input.stack_name,
        region: input.region,
        environment: input.environment,
        status: "PENDING".to_string(),
        template_type: input.template_type,
        change_set_id: None,
        parameters: input.parameters,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    db.create_plan(&plan)?;
    Ok(plan)
}

#[tauri::command]
pub fn delete_plan(db: State<'_, AppDatabase>, plan_id: String) -> Result<(), String> {
    db.delete_plan(&plan_id)
}

// --- Deployments ---

#[tauri::command]
pub fn get_deployment(
    db: State<'_, AppDatabase>,
    plan_id: String,
) -> Result<Option<Deployment>, String> {
    db.get_latest_deployment(&plan_id)
}

// --- File Browser ---

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
}

#[tauri::command]
pub fn list_directory(path: Option<String>) -> Result<Vec<FileEntry>, String> {
    let dir = match path {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => dirs::home_dir().ok_or("Cannot determine home directory")?,
    };

    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("Cannot read {}: {}", dir.display(), e))?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files
        if name.starts_with('.') {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| {
                chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            });

        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified,
        });
    }

    // Directories first, then alphabetical
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));

    Ok(entries)
}

#[tauri::command]
pub fn get_parent_directory(path: String) -> Result<Option<String>, String> {
    let p = PathBuf::from(&path);
    Ok(p.parent().map(|parent| parent.to_string_lossy().to_string()))
}

// ---------------------------------------------------------------------------
// Cloud config commands
//
// These read/write two JSON files in ~/.starkeep/:
//   cloud-config.json      — Cognito pool IDs, S3 bucket, Aurora endpoint,
//                            refresh token. Safe to store; no short-lived creds.
//   cloud-credentials.json — Short-lived STS credentials refreshed by
//                            admin-desktop every 45 min.
// ---------------------------------------------------------------------------

fn starkeep_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let dir = home.join(".starkeep");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create ~/.starkeep: {e}"))?;
    Ok(dir)
}

#[derive(Serialize)]
pub struct CloudSetupState {
    /// "unconfigured" | "configured"
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
pub fn write_cloud_config(config_json: String) -> Result<(), String> {
    // Validate it's well-formed JSON before writing.
    serde_json::from_str::<serde_json::Value>(&config_json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;
    let path = starkeep_dir()?.join("cloud-config.json");
    std::fs::write(&path, &config_json).map_err(|e| format!("Cannot write cloud-config.json: {e}"))
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
pub fn write_cloud_credentials(creds_json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&creds_json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;
    let path = starkeep_dir()?.join("cloud-credentials.json");
    std::fs::write(&path, &creds_json)
        .map_err(|e| format!("Cannot write cloud-credentials.json: {e}"))
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

/// Write the bootstrap CloudFormation template YAML to ~/.starkeep/bootstrap-template.yaml
/// so the user can upload it to the AWS CloudFormation console.
#[tauri::command]
pub fn write_bootstrap_template(yaml: String) -> Result<String, String> {
    let path = starkeep_dir()?.join("bootstrap-template.yaml");
    std::fs::write(&path, &yaml)
        .map_err(|e| format!("Cannot write bootstrap-template.yaml: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// S3 commands — run natively to avoid browser CORS restrictions
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: String,
}

fn make_s3_client(credentials: S3Credentials, region: String) -> aws_sdk_s3::Client {
    use aws_sdk_s3::config::{Credentials, Region};
    let creds = Credentials::new(
        credentials.access_key_id,
        credentials.secret_access_key,
        Some(credentials.session_token),
        None,
        "starkeep",
    );
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
        .credentials_provider(creds)
        .region(Region::new(region))
        .build();
    aws_sdk_s3::Client::from_conf(config)
}

/// Upload base64-encoded bytes to S3 from the native side (no CORS).
#[tauri::command]
pub async fn s3_put_object(
    bucket: String,
    key: String,
    body_base64: String,
    content_type: String,
    credentials: S3Credentials,
    region: String,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use aws_sdk_s3::primitives::ByteStream;

    let body = STANDARD.decode(&body_base64)
        .map_err(|e| format!("Invalid base64: {e}"))?;

    let client = make_s3_client(credentials, region);
    client.put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(body))
        .content_type(content_type)
        .send()
        .await
        .map_err(|e| match e.as_service_error() {
            Some(se) => format!(
                "S3 PutObject failed: {} — {}",
                se.meta().code().unwrap_or("unknown"),
                se.meta().message().unwrap_or("no message"),
            ),
            None => format!("S3 PutObject failed: {e}"),
        })?;

    Ok(())
}

/// Download an S3 object and return its contents as a UTF-8 string (no CORS).
#[tauri::command]
pub async fn s3_get_object_text(
    bucket: String,
    key: String,
    credentials: S3Credentials,
    region: String,
) -> Result<String, String> {
    let client = make_s3_client(credentials, region);
    let resp = client.get_object()
        .bucket(bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| match e.as_service_error() {
            Some(se) => format!(
                "S3 GetObject failed: {} — {} (key: {})",
                se.meta().code().unwrap_or("unknown"),
                se.meta().message().unwrap_or("no message"),
                key,
            ),
            None => format!("S3 GetObject failed: {e}"),
        })?;

    let bytes = resp.body.collect().await
        .map_err(|e| format!("Failed to read S3 body: {e}"))?;

    String::from_utf8(bytes.into_bytes().to_vec())
        .map_err(|e| format!("S3 response is not valid UTF-8: {e}"))
}

