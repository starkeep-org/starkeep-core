mod backend;
mod config;
mod fuse_fs;
mod management_api;

use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,opendal=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Starting Starkeeper Data Gateway");
    info!("Version: {}", env!("CARGO_PKG_VERSION"));
    info!("Zero data access guarantee: Control plane CANNOT access data through this gateway");

    // Load configuration
    let config = config::Config::from_env()?;
    config.validate()?;

    info!(
        backend = %config.backend,
        mount_point = %config.mount_point,
        "Configuration loaded"
    );

    // Create OpenDAL operator
    let operator = backend::create_operator(&config).await?;
    info!("OpenDAL operator created successfully");

    // Start management API in background task
    let api_state = management_api::ApiState {
        config: Arc::new(RwLock::new(config.clone())),
        version: env!("CARGO_PKG_VERSION").to_string(),
        start_time: chrono::Utc::now(),
    };

    let management_port = config.management_port;
    let management_task = tokio::spawn(async move {
        let app = management_api::create_router(api_state);
        let addr = format!("0.0.0.0:{}", management_port);

        info!(addr = %addr, "Starting management API server");

        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .expect("Failed to bind management API");

        axum::serve(listener, app)
            .await
            .expect("Management API server failed");
    });

    // Mount FUSE filesystem
    info!(mount_point = %config.mount_point, "Mounting FUSE filesystem");
    let fs = fuse_fs::OpenDALFilesystem::new(operator);

    // Run FUSE mount (this blocks until unmount)
    if let Err(e) = fs.mount(&config.mount_point).await {
        error!(error = %e, "Failed to mount FUSE filesystem");
        return Err(e);
    }

    // Wait for management API task
    management_task.await?;

    Ok(())
}
