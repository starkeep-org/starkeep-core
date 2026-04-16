use serde::{Deserialize, Serialize};

/// Gateway configuration from environment variables
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Config {
    /// Backend type: s3, fs, efs
    #[serde(default = "default_backend")]
    pub backend: String,

    /// S3 bucket name (if backend = s3)
    pub s3_bucket: Option<String>,

    /// S3 region (if backend = s3)
    #[serde(default = "default_region")]
    pub s3_region: String,

    /// S3 endpoint (for S3-compatible services)
    pub s3_endpoint: Option<String>,

    /// Filesystem root path (if backend = fs)
    pub fs_root: Option<String>,

    /// FUSE mount point
    #[serde(default = "default_mount_point")]
    pub mount_point: String,

    /// Management API port
    #[serde(default = "default_management_port")]
    pub management_port: u16,

    /// Enable Prometheus metrics
    #[serde(default = "default_true")]
    pub metrics_enabled: bool,

    /// Log level
    #[serde(default = "default_log_level")]
    pub log_level: String,

    /// Maximum cache size in bytes (0 = no cache)
    #[serde(default)]
    pub cache_size_bytes: u64,
}

fn default_backend() -> String {
    "s3".to_string()
}

fn default_region() -> String {
    "us-east-1".to_string()
}

fn default_mount_point() -> String {
    "/mnt/data".to_string()
}

fn default_management_port() -> u16 {
    8080
}

fn default_true() -> bool {
    true
}

fn default_log_level() -> String {
    "info".to_string()
}

impl Config {
    /// Load configuration from environment variables with GATEWAY_ prefix
    pub fn from_env() -> anyhow::Result<Self> {
        envy::prefixed("GATEWAY_").from_env::<Config>()
            .map_err(|e| anyhow::anyhow!("Failed to load config from environment: {}", e))
    }

    /// Validate configuration
    pub fn validate(&self) -> anyhow::Result<()> {
        match self.backend.as_str() {
            "s3" => {
                if self.s3_bucket.is_none() {
                    anyhow::bail!("s3_bucket is required when backend=s3");
                }
            }
            "fs" => {
                if self.fs_root.is_none() {
                    anyhow::bail!("fs_root is required when backend=fs");
                }
            }
            "efs" => {
                // EFS is just NFS, uses fs backend
                if self.fs_root.is_none() {
                    anyhow::bail!("fs_root is required when backend=efs");
                }
            }
            backend => {
                anyhow::bail!("Unsupported backend: {}", backend);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_s3_config() {
        let config = Config {
            backend: "s3".to_string(),
            s3_bucket: Some("test-bucket".to_string()),
            s3_region: "us-east-1".to_string(),
            s3_endpoint: None,
            fs_root: None,
            mount_point: "/mnt/data".to_string(),
            management_port: 8080,
            metrics_enabled: true,
            log_level: "info".to_string(),
            cache_size_bytes: 0,
        };

        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_fs_config() {
        let config = Config {
            backend: "fs".to_string(),
            s3_bucket: None,
            s3_region: "us-east-1".to_string(),
            s3_endpoint: None,
            fs_root: Some("/data".to_string()),
            mount_point: "/mnt/data".to_string(),
            management_port: 8080,
            metrics_enabled: true,
            log_level: "info".to_string(),
            cache_size_bytes: 0,
        };

        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_missing_s3_bucket() {
        let config = Config {
            backend: "s3".to_string(),
            s3_bucket: None,
            s3_region: "us-east-1".to_string(),
            s3_endpoint: None,
            fs_root: None,
            mount_point: "/mnt/data".to_string(),
            management_port: 8080,
            metrics_enabled: true,
            log_level: "info".to_string(),
            cache_size_bytes: 0,
        };

        assert!(config.validate().is_err());
    }
}
