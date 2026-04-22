use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppDatabase {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AwsSettings {
    pub id: String,
    pub account_id: String,
    pub default_region: String,
    pub stack_prefix: String,
    pub role_arn: String,
    pub external_id: String,
    pub execution_role_arn: Option<String>,
    pub permission_boundary_arn: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Plan {
    pub id: String,
    pub stack_name: String,
    pub region: String,
    pub environment: Option<String>,
    pub status: String,
    pub template_type: Option<String>,
    pub change_set_id: Option<String>,
    pub parameters: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Deployment {
    pub id: String,
    pub plan_id: String,
    pub stack_name: String,
    pub region: String,
    pub status: String,
    pub status_reason: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

impl AppDatabase {
    pub fn open(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let db_path = data_dir.join("admin.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;

        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS aws_settings (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                default_region TEXT NOT NULL DEFAULT 'us-east-1',
                stack_prefix TEXT NOT NULL DEFAULT 'app',
                role_arn TEXT NOT NULL,
                external_id TEXT NOT NULL,
                execution_role_arn TEXT,
                permission_boundary_arn TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS plans (
                id TEXT PRIMARY KEY,
                stack_name TEXT NOT NULL,
                region TEXT NOT NULL,
                environment TEXT,
                status TEXT NOT NULL DEFAULT 'PENDING',
                template_type TEXT,
                change_set_id TEXT,
                parameters TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS deployments (
                id TEXT PRIMARY KEY,
                plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
                stack_name TEXT NOT NULL,
                region TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
                status_reason TEXT,
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                completed_at TEXT
            );
            ",
        )
        .map_err(|e| e.to_string())
    }

    // --- AWS Settings ---

    pub fn get_aws_settings(&self) -> Result<Option<AwsSettings>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, account_id, default_region, stack_prefix, role_arn, external_id, execution_role_arn, permission_boundary_arn, created_at FROM aws_settings LIMIT 1")
            .map_err(|e| e.to_string())?;

        let result = stmt
            .query_row([], |row| {
                Ok(AwsSettings {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    default_region: row.get(2)?,
                    stack_prefix: row.get(3)?,
                    role_arn: row.get(4)?,
                    external_id: row.get(5)?,
                    execution_role_arn: row.get(6)?,
                    permission_boundary_arn: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })
            .ok();

        Ok(result)
    }

    pub fn save_aws_settings(&self, settings: &AwsSettings) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO aws_settings (id, account_id, default_region, stack_prefix, role_arn, external_id, execution_role_arn, permission_boundary_arn, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                settings.id,
                settings.account_id,
                settings.default_region,
                settings.stack_prefix,
                settings.role_arn,
                settings.external_id,
                settings.execution_role_arn,
                settings.permission_boundary_arn,
                settings.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Plans ---

    pub fn list_plans(&self) -> Result<Vec<Plan>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, stack_name, region, environment, status, template_type, change_set_id, parameters, created_at FROM plans ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;

        let plans = stmt
            .query_map([], |row| {
                Ok(Plan {
                    id: row.get(0)?,
                    stack_name: row.get(1)?,
                    region: row.get(2)?,
                    environment: row.get(3)?,
                    status: row.get(4)?,
                    template_type: row.get(5)?,
                    change_set_id: row.get(6)?,
                    parameters: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(plans)
    }

    pub fn get_plan(&self, id: &str) -> Result<Option<Plan>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, stack_name, region, environment, status, template_type, change_set_id, parameters, created_at FROM plans WHERE id = ?1")
            .map_err(|e| e.to_string())?;

        let result = stmt
            .query_row(params![id], |row| {
                Ok(Plan {
                    id: row.get(0)?,
                    stack_name: row.get(1)?,
                    region: row.get(2)?,
                    environment: row.get(3)?,
                    status: row.get(4)?,
                    template_type: row.get(5)?,
                    change_set_id: row.get(6)?,
                    parameters: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })
            .ok();

        Ok(result)
    }

    pub fn create_plan(&self, plan: &Plan) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO plans (id, stack_name, region, environment, status, template_type, change_set_id, parameters, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                plan.id, plan.stack_name, plan.region, plan.environment,
                plan.status, plan.template_type, plan.change_set_id,
                plan.parameters, plan.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_plan_status(&self, id: &str, status: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE plans SET status = ?1 WHERE id = ?2",
            params![status, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_plan(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM plans WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Deployments ---

    pub fn get_latest_deployment(&self, plan_id: &str) -> Result<Option<Deployment>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, plan_id, stack_name, region, status, status_reason, started_at, completed_at FROM deployments WHERE plan_id = ?1 ORDER BY started_at DESC LIMIT 1")
            .map_err(|e| e.to_string())?;

        let result = stmt
            .query_row(params![plan_id], |row| {
                Ok(Deployment {
                    id: row.get(0)?,
                    plan_id: row.get(1)?,
                    stack_name: row.get(2)?,
                    region: row.get(3)?,
                    status: row.get(4)?,
                    status_reason: row.get(5)?,
                    started_at: row.get(6)?,
                    completed_at: row.get(7)?,
                })
            })
            .ok();

        Ok(result)
    }

    pub fn create_deployment(&self, deployment: &Deployment) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO deployments (id, plan_id, stack_name, region, status, status_reason, started_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                deployment.id, deployment.plan_id, deployment.stack_name,
                deployment.region, deployment.status, deployment.status_reason,
                deployment.started_at, deployment.completed_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_deployment_status(
        &self,
        id: &str,
        status: &str,
        reason: Option<&str>,
        completed_at: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE deployments SET status = ?1, status_reason = ?2, completed_at = ?3 WHERE id = ?4",
            params![status, reason, completed_at, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
