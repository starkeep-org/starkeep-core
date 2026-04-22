use anyhow::Result;
use opendal::{Operator, services};
use crate::config::Config;

/// Initialize OpenDAL operator based on configuration
pub async fn create_operator(config: &Config) -> Result<Operator> {
    match config.backend.as_str() {
        "s3" => create_s3_operator(config).await,
        "fs" | "efs" => create_fs_operator(config),
        backend => Err(anyhow::anyhow!("Unsupported backend: {}", backend)),
    }
}

/// Create S3 backend operator
/// Uses IAM role credentials automatically (DataPlaneRuntimeRole)
async fn create_s3_operator(config: &Config) -> Result<Operator> {
    let bucket = config.s3_bucket.as_ref()
        .ok_or_else(|| anyhow::anyhow!("S3 bucket not configured"))?;

    tracing::info!(
        bucket = %bucket,
        region = %config.s3_region,
        "Initializing S3 backend"
    );

    // Build S3 service
    let mut builder = services::S3::default();
    builder.bucket(bucket);
    builder.region(&config.s3_region);

    // Use custom endpoint if provided (for S3-compatible services)
    if let Some(endpoint) = &config.s3_endpoint {
        builder.endpoint(endpoint);
    }

    // OpenDAL automatically uses AWS SDK credential chain:
    // 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
    // 2. IAM role credentials (ECS task role, EC2 instance profile)
    // 3. ~/.aws/credentials file

    // For ECS, this means it will use the DataPlaneRuntimeRole automatically
    // Control plane CANNOT assume this role (enforced in bootstrap template)

    let op = Operator::new(builder)?
        .layer(opendal::layers::LoggingLayer::default())
        .finish();

    // Test connection
    op.check().await?;

    tracing::info!("S3 backend initialized successfully");

    Ok(op)
}

/// Create filesystem backend operator
fn create_fs_operator(config: &Config) -> Result<Operator> {
    let root = config.fs_root.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Filesystem root not configured"))?;

    tracing::info!(
        root = %root,
        backend = %config.backend,
        "Initializing filesystem backend"
    );

    let mut builder = services::Fs::default();
    builder.root(root);

    let op = Operator::new(builder)?
        .layer(opendal::layers::LoggingLayer::default())
        .finish();

    tracing::info!("Filesystem backend initialized successfully");

    Ok(op)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_fs_operator() {
        let config = Config {
            backend: "fs".to_string(),
            s3_bucket: None,
            s3_region: "us-east-1".to_string(),
            s3_endpoint: None,
            fs_root: Some("/tmp".to_string()),
            mount_point: "/mnt/data".to_string(),
            management_port: 8080,
            metrics_enabled: true,
            log_level: "info".to_string(),
            cache_size_bytes: 0,
        };

        let result = create_fs_operator(&config);
        assert!(result.is_ok());
    }
}
