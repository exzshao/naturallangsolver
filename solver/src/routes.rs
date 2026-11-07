//! HTTP routing: `/health`, `/admit` (rate limit), and `/solve` (one solve at
//! a time behind a bounded FIFO queue, optionally streamed as NDJSON).
//! Everything but `/health` sits behind the `x-solver-key` check.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::{Instant, interval_at};
use tower_http::cors::CorsLayer;

use crate::api::{ErrorBody, SolveRequest, SolveResponse};
use crate::auth;
use crate::config::{self, Prepared, Settings};
use crate::error::{QUEUE_TIMED_OUT, Reason, SolveError};
use crate::queue::{Admission, Permit, QueueError, SolveQueue};
use crate::rate_limit::{Decision, RateLimiter};
use crate::solve;

/// `Accept` value that switches `/solve` to a streamed NDJSON response.
pub const NDJSON: &str = "application/x-ndjson";
/// While queued or solving, the stream repeats the current status this often,
/// so proxies don't drop an idle connection and a gone client is noticed.
pub const HEARTBEAT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    /// One running solve plus up to `QUEUE_MAX_WAITING` waiting, FIFO.
    pub queue: SolveQueue,
    pub limiter: Arc<RateLimiter>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        let limiter = RateLimiter::new(settings.rate_limit_per_ip_hour, settings.rate_limit_global_day);
        let queue = SolveQueue::new(settings.queue_max_waiting, settings.queue_max_wait);
        Self { settings: Arc::new(settings), queue, limiter: Arc::new(limiter) }
    }
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/admit", post(admit_handler))
        .route("/solve", post(solve_handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_key));
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(protected)
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[derive(Deserialize)]
struct AdmitRequest {
    ip: String,
}

/// `POST /admit {"ip": "..."}`: the app calls this before spending an LLM call.
/// 200 `{"status":"ok"}` records one solve; 429 RATE_LIMITED records nothing.
async fn admit_handler(State(state): State<AppState>, body: Bytes) -> Response {
    let ip = match serde_json::from_slice::<AdmitRequest>(&body) {
        Ok(r) => r.ip.trim().to_string(),
        Err(e) => return SolveError::new(Reason::InvalidRequest, e.to_string()).into_response(),
    };
    if ip.is_empty() || ip.len() > 64 {
        return SolveError::new(Reason::InvalidRequest, "ip must be 1-64 characters").into_response();
    }
    match state.limiter.admit(&ip) {
        Decision::Admit => (StatusCode::OK, Json(json!({"status": "ok"}))).into_response(),
        Decision::IpLimited => SolveError::new(Reason::RateLimited, format!("per-IP limit for {ip}")).into_response(),
        Decision::GlobalLimited => SolveError::new(Reason::RateLimited, "global daily limit").into_response(),
    }
}

/// One line of the streamed `/solve` response (SPEC §7).
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    /// In line; 1 = next to run. Sent on joining, on every move, and as a heartbeat.
    Queued { position: usize },
    /// Holding the slot. Sent once, then as a heartbeat.
    Solving,
    /// Final line on success: the plain-JSON 200 body plus `type`.
    Result(SolveResponse),
    /// Final line on failure: the §6 body plus `type`.
    Error(ErrorBody),
}

fn wants_ndjson(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|part| part.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case(NDJSON))
}

fn queue_full(state: &AppState) -> SolveError {
    SolveError::new(Reason::SolverBusy, format!("queue full ({} waiting)", state.queue.waiting()))
}

fn queue_timed_out(settings: &Settings) -> SolveError {
    SolveError::new(Reason::SolverBusy, format!("waited {:?} in the queue", settings.queue_max_wait))
        .with_message(QUEUE_TIMED_OUT)
}

/// `POST /solve`. Bad input is rejected before queueing. A full queue is an
/// immediate 503. Otherwise the request waits its turn, then solves; with
/// `Accept: application/x-ndjson` the wait and the result are streamed.
async fn solve_handler(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let req: SolveRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return SolveError::new(Reason::InvalidRequest, e.to_string()).into_response(),
    };

    // Cheap validation first, so bad input gets a 422 without waiting in line.
    let prepared = match config::prepare(&req, &state.settings) {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };

    let admission = match state.queue.join() {
        Ok(a) => a,
        Err(_) => return queue_full(&state).into_response(),
    };

    if wants_ndjson(&headers) {
        return stream_solve(state.settings.clone(), prepared, admission);
    }

    // Plain JSON: if the client disconnects, axum drops this future, which
    // drops the ticket and frees the place in line.
    let permit = match admission {
        Admission::Ready(p) => p,
        Admission::Queued(ticket) => match ticket.wait(|_| {}).await {
            Ok(p) => p,
            Err(QueueError::TimedOut | QueueError::Full) => {
                return queue_timed_out(&state.settings).into_response();
            }
        },
    };
    match run_solve(prepared, permit, state.settings.clone()).await {
        Ok(resp) => (StatusCode::OK, Json(resp)).into_response(),
        Err(e) => e.into_response(),
    }
}

/// Runs the solve on the blocking pool. The permit moves into the blocking
/// task, so it stays held until the solve actually ends, even if the client
/// disconnects and this future is dropped.
async fn run_solve(prepared: Prepared, permit: Permit, settings: Arc<Settings>) -> Result<SolveResponse, SolveError> {
    let handle = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        solve::run(prepared, &settings)
    });
    match handle.await {
        Ok(r) => r,
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
            Err(SolveError::from_crate(detail))
        }
    }
}

/// 200 NDJSON response fed by a task that waits in line and solves. When the
/// client goes away the body (and its receiver) is dropped; the task sees the
/// closed channel and returns, which leaves the line if still waiting.
fn stream_solve(settings: Arc<Settings>, prepared: Prepared, admission: Admission) -> Response {
    let (tx, rx) = mpsc::channel::<Event>(32);
    tokio::spawn(drive_stream(settings, prepared, admission, tx));
    let lines = futures_util::stream::unfold(rx, |mut rx| async move {
        let event = rx.recv().await?;
        let mut line = serde_json::to_vec(&event).unwrap_or_else(|_| b"{}".to_vec());
        line.push(b'\n');
        Some((Ok::<_, Infallible>(Bytes::from(line)), rx))
    });
    let mut resp = Response::new(Body::from_stream(lines));
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(NDJSON));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}

async fn drive_stream(settings: Arc<Settings>, prepared: Prepared, admission: Admission, tx: mpsc::Sender<Event>) {
    let permit = match admission {
        Admission::Ready(p) => p,
        Admission::Queued(ticket) => {
            let position = AtomicUsize::new(0);
            let wait = ticket.wait(|p| {
                position.store(p, Ordering::Relaxed);
                let _ = tx.try_send(Event::Queued { position: p });
            });
            tokio::pin!(wait);
            let mut beat = interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
            loop {
                tokio::select! {
                    r = &mut wait => match r {
                        Ok(p) => break p,
                        Err(_) => {
                            let err = queue_timed_out(&settings);
                            err.log();
                            let _ = tx.send(Event::Error(err.body())).await;
                            return;
                        }
                    },
                    _ = beat.tick() => {
                        let _ = tx.try_send(Event::Queued { position: position.load(Ordering::Relaxed) });
                    }
                    _ = tx.closed() => {
                        tracing::info!("client left the queue");
                        return;
                    }
                }
            }
        }
    };

    let _ = tx.try_send(Event::Solving);
    let solve = run_solve(prepared, permit, settings);
    tokio::pin!(solve);
    let mut beat = interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
    loop {
        tokio::select! {
            r = &mut solve => {
                let event = match r {
                    Ok(resp) => Event::Result(resp),
                    Err(e) => {
                        e.log();
                        Event::Error(e.body())
                    }
                };
                let _ = tx.send(event).await;
                return;
            }
            _ = beat.tick() => {
                let _ = tx.try_send(Event::Solving);
            }
            _ = tx.closed() => {
                // The blocking solve keeps the slot until it finishes.
                tracing::info!("client disconnected during solve");
                return;
            }
        }
    }
}
