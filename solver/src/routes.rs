//! HTTP routing: `/health` and `/solve`, with a one-at-a-time solve permit.

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use tokio::sync::Semaphore;
use tower_http::cors::CorsLayer;

use crate::api::SolveRequest;
use crate::config::{self, Settings};
use crate::error::{Reason, SolveError};
use crate::solve;

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    /// One permit: only one solve runs at a time.
    pub permits: Arc<Semaphore>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self { settings: Arc::new(settings), permits: Arc::new(Semaphore::new(1)) }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/solve", post(solve_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn solve_handler(State(state): State<AppState>, body: Bytes) -> Response {
    let req: SolveRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return SolveError::new(Reason::InvalidRequest, e.to_string()).into_response(),
    };

    // Cheap validation first, so bad input gets a 422 even while busy.
    let prepared = match config::prepare(&req, &state.settings) {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };

    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return SolveError::new(Reason::SolverBusy, "another solve is running").into_response();
    };

    let settings = state.settings.clone();
    // The permit moves into the blocking task, so it stays held until the solve
    // actually ends, even if the client disconnects and this future is dropped.
    let handle = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        solve::run(prepared, &settings)
    });

    match handle.await {
        Ok(Ok(resp)) => (StatusCode::OK, Json(resp)).into_response(),
        Ok(Err(e)) => e.into_response(),
        Err(join_err) => {
            let detail = if join_err.is_panic() {
                let p = join_err.into_panic();
                let msg = p
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| p.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".into());
                format!("solver panicked: {msg}")
            } else {
                format!("solve task failed: {join_err}")
            };
            tracing::error!("{detail}");
            // A panic inside the crate may surface a more specific reason (e.g. huge tree).
            SolveError::from_crate(detail).into_response()
        }
    }
}
