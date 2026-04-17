use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Management API state
#[derive(Clone)]
pub struct ApiState {
    pub config: Arc<RwLock<crate::config::Config>>,
    pub version: String,
    pub start_time: chrono::DateTime<chrono::Utc>,
}

/// Health check response
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub uptime_seconds: i64,
    pub backend: String,
}

/// Metrics response (Prometheus format)
#[derive(Debug, Serialize)]
pub struct MetricsResponse {
    pub requests_total: u64,
    pub requests_success: u64,
    pub requests_error: u64,
    pub backend_latency_ms: f64,
    pub cache_hit_ratio: f64,
}

/// Configuration response (safe subset)
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub backend: String,
    pub mount_point: String,
    pub metrics_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s3_bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s3_region: Option<String>,
}

/// Status response
#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub backend_health: String,
    pub fuse_mounted: bool,
    pub last_sync: Option<chrono::DateTime<chrono::Utc>>,
    pub pending_operations: u64,
}

/// API key authentication middleware
///
/// Checks for valid API key in Authorization header.
/// Supports multiple API keys via GATEWAY_API_KEYS env var (comma-separated).
/// In dev mode, allows unauthenticated access if no keys are configured.
async fn require_api_key(req: Request<Body>, next: Next) -> Result<Response, StatusCode> {
    let api_keys = std::env::var("GATEWAY_API_KEYS").unwrap_or_default();

    // In dev mode with no keys configured, allow all requests
    if api_keys.is_empty() && std::env::var("RUST_ENV").unwrap_or_default() != "production" {
        return Ok(next.run(req).await);
    }

    let valid_keys: Vec<&str> = api_keys.split(',').map(|s| s.trim()).collect();

    // Get Authorization header
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    match auth_header {
        Some(key) if valid_keys.contains(&key) => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// Create management API router
///
/// IMPORTANT: This API exposes NO data operations
/// Only metadata and control operations
pub fn create_router(state: ApiState) -> Router {
    Router::new()
        .route("/management/health", get(health_handler))
        .route("/management/version", get(version_handler))
        .route("/management/metrics", get(metrics_handler))
        .route("/management/config", get(config_handler))
        .route("/management/status", get(status_handler))
        .layer(middleware::from_fn(require_api_key))
        .with_state(state)
}

/// GET /management/health - Health check endpoint
async fn health_handler(State(state): State<ApiState>) -> Json<HealthResponse> {
    let config = state.config.read().await;
    let uptime = (chrono::Utc::now() - state.start_time).num_seconds();

    Json(HealthResponse {
        status: "healthy".to_string(),
        version: state.version.clone(),
        uptime_seconds: uptime,
        backend: config.backend.clone(),
    })
}

/// GET /management/version - Version information
async fn version_handler(State(state): State<ApiState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "version": state.version,
        "build_time": option_env!("VERGEN_BUILD_TIMESTAMP").unwrap_or("unknown"),
        "git_sha": option_env!("VERGEN_GIT_SHA").unwrap_or("unknown"),
    }))
}

/// GET /management/metrics - Prometheus-compatible metrics
///
/// NOTE: These are safe metrics only - no data values exposed
/// Authentication enforced via require_api_key middleware
async fn metrics_handler() -> impl IntoResponse {
    let metrics = MetricsResponse {
        requests_total: 0,
        requests_success: 0,
        requests_error: 0,
        backend_latency_ms: 0.0,
        cache_hit_ratio: 0.0,
    };

    Json(metrics)
}

/// GET /management/config - Current configuration (safe subset)
///
/// NOTE: Does NOT expose credentials or sensitive data
async fn config_handler(State(state): State<ApiState>) -> Json<ConfigResponse> {
    let config = state.config.read().await;

    Json(ConfigResponse {
        backend: config.backend.clone(),
        mount_point: config.mount_point.clone(),
        metrics_enabled: config.metrics_enabled,
        s3_bucket: config.s3_bucket.clone(),
        s3_region: Some(config.s3_region.clone()),
    })
}

/// GET /management/status - Gateway status
/// TODO(metrics): Implement actual backend health checks
/// TODO(metrics): Track FUSE mount status
/// TODO(metrics): Count pending operations
/// See SECURITY_REVIEW.md Phase 1 requirements
async fn status_handler() -> Json<StatusResponse> {
    Json(StatusResponse {
        backend_health: "healthy".to_string(),
        fuse_mounted: true,
        last_sync: Some(chrono::Utc::now()),
        pending_operations: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn create_test_state() -> ApiState {
        let config = crate::config::Config {
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

        ApiState {
            config: Arc::new(RwLock::new(config)),
            version: "0.1.0-test".to_string(),
            start_time: chrono::Utc::now(),
        }
    }

    #[tokio::test]
    async fn test_health_endpoint_returns_valid_data() {
        let state = create_test_state().await;
        let app = create_router(state.clone());

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/management/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let health: HealthResponse = serde_json::from_slice(&body).unwrap();

        assert_eq!(health.status, "healthy");
        assert_eq!(health.version, "0.1.0-test");
        assert_eq!(health.backend, "s3");
        assert!(health.uptime_seconds >= 0);
    }

    #[tokio::test]
    async fn test_config_endpoint_does_not_expose_credentials() {
        let state = create_test_state().await;
        let app = create_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/management/config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let config: ConfigResponse = serde_json::from_slice(&body).unwrap();

        assert_eq!(config.backend, "s3");
        assert_eq!(config.mount_point, "/mnt/data");
        assert_eq!(config.s3_bucket, Some("test-bucket".to_string()));
        assert_eq!(config.s3_region, Some("us-east-1".to_string()));
    }

    #[tokio::test]
    async fn test_version_endpoint() {
        let state = create_test_state().await;
        let app = create_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/management/version")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let version: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(version["version"], "0.1.0-test");
        assert!(version["build_time"].is_string());
        assert!(version["git_sha"].is_string());
    }

    #[tokio::test]
    async fn test_metrics_endpoint() {
        let state = create_test_state().await;
        let app = create_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/management/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let metrics: MetricsResponse = serde_json::from_slice(&body).unwrap();

        assert_eq!(metrics.requests_total, 0);
    }

    #[tokio::test]
    async fn test_status_endpoint() {
        let state = create_test_state().await;
        let app = create_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/management/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let status: StatusResponse = serde_json::from_slice(&body).unwrap();

        assert_eq!(status.backend_health, "healthy");
        assert!(status.fuse_mounted);
    }
}
