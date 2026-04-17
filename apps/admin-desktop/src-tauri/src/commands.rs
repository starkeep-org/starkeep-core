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

