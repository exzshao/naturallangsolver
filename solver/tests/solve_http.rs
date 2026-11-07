//! HTTP-level tests against the router (no network). Run with `cargo test --release`
//! for speed; the default tests use a tiny river spot so debug builds are fine too.

use std::time::Duration;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use solver_service::config::ApiKey;
use solver_service::{AppState, Settings, router};
use tower::ServiceExt;

const SRP_IP: &str = "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o";
const SRP_OOP: &str = "22-JJ,A2s-AJs,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,75s+,64s+,53s+,A2o-AJo,K9o+,Q9o+,J9o+,T9o";

fn sizes() -> Value {
    json!({
        "flop":  {"bet": "33%, 75%", "raise": "3x"},
        "turn":  {"bet": "33%, 75%", "raise": "3x"},
        "river": {"bet": "33%, 75%, a", "raise": "3x"}
    })
}

/// Tiny river spot: narrow ranges so it solves fast even in debug builds.
fn tiny_river() -> Value {
    json!({
        "board": "Td9d6hQc2s",
        "oop_range": "QQ,JJ,AQs,KJs,87s",
        "ip_range": "AA,KK,AKs,J8s,T9s",
        "starting_pot": 550,
        "effective_stack": 9750,
        "bet_sizes": sizes(),
        "hero": {"player": "ip", "hand": "AhKh"},
        "max_iterations": 200,
        "target_exploitability_pct": 0.5
    })
}

fn settings() -> Settings {
    Settings {
        port: 0,
        max_memory_mb: 4096,
        solve_timeout: Duration::from_secs(60),
        max_iterations: 1000,
        ..Settings::default()
    }
}

const KEY: &str = "test-key-0123456789";

fn keyed_settings() -> Settings {
    Settings { api_key: Some(ApiKey(KEY.into())), ..settings() }
}

/// Sends a request and returns (status, body). Non-JSON bodies come back as a JSON string.
async fn send(state: AppState, method: &str, path: &str, key: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
    if let Some(k) = key {
        req = req.header("x-solver-key", k);
    }
    let req = req.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
    let resp = router(state).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
    (status, v)
}

async fn post(state: AppState, body: Value) -> (StatusCode, Value) {
    send(state, "POST", "/solve", None, Some(body)).await
}

async fn admit(state: &AppState, key: Option<&str>, ip: &str) -> (StatusCode, Value) {
    send(state.clone(), "POST", "/admit", key, Some(json!({ "ip": ip }))).await
}

fn assert_frequencies_sum_to_one(v: &Value) {
    let nodes = v["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 2);
    for node in nodes {
        let sum: f64 = node["actions"].as_array().unwrap().iter().map(|a| a["frequency"].as_f64().unwrap()).sum();
        assert!((sum - 1.0).abs() < 1e-3, "node {:?} sums to {sum}", node["line"]);
        for a in node["actions"].as_array().unwrap() {
            assert!(a["top_hands"].as_array().unwrap().len() <= 6);
            assert_eq!(a["top_classes"].as_array().unwrap().len(), a["top_hands"].as_array().unwrap().len());
        }
    }
}

#[tokio::test]
async fn tiny_river_spot_solves() {
    let (status, v) = post(AppState::new(settings()), tiny_river()).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "ok");
    assert_frequencies_sum_to_one(&v);
    assert_eq!(v["nodes"][0]["player"], "oop");
    assert_eq!(v["nodes"][0]["line"], json!([]));
    assert_eq!(v["nodes"][1]["player"], "ip");
    assert_eq!(v["nodes"][1]["line"], json!(["Check"]));
    assert_eq!(v["nodes"][0]["actions"][0]["action"], "Check");

    let eq_sum = v["players"]["oop"]["equity"].as_f64().unwrap() + v["players"]["ip"]["equity"].as_f64().unwrap();
    assert!((eq_sum - 1.0).abs() < 1e-2, "equities sum to {eq_sum}");
    let ev_sum = v["players"]["oop"]["ev"].as_f64().unwrap() + v["players"]["ip"]["ev"].as_f64().unwrap();
    assert!((ev_sum - 550.0).abs() < 5.0, "EVs sum to {ev_sum}");

    let hero = &v["hero_hand"];
    assert_eq!(hero["hand"], "AhKh");
    assert_eq!(hero["node"], 1);
    let hsum: f64 = hero["actions"].as_array().unwrap().iter().map(|a| a["frequency"].as_f64().unwrap()).sum();
    assert!((hsum - 1.0).abs() < 1e-3);
}

#[tokio::test]
async fn duplicate_board_is_invalid_board() {
    let mut body = tiny_river();
    body["board"] = json!("Td9d6hTd2s");
    let (status, v) = post(AppState::new(settings()), body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["status"], "cant_solve");
    assert_eq!(v["reason"], "INVALID_BOARD");
}

#[tokio::test]
async fn hero_hand_on_board_is_invalid_board() {
    let mut body = tiny_river();
    body["hero"] = json!({"player": "ip", "hand": "Td8c"});
    let (status, v) = post(AppState::new(settings()), body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["reason"], "INVALID_BOARD");
}

#[tokio::test]
async fn bad_inputs_map_to_reasons() {
    let cases = [
        ("oop_range", json!("ZZ+"), "INVALID_RANGE"),
        ("ip_range", json!("TdTc"), "INVALID_RANGE"), // empty after board blockers
        ("bet_sizes", json!({"flop": {"bet": "3x", "raise": ""}, "turn": {"bet": "", "raise": ""}, "river": {"bet": "", "raise": ""}}), "INVALID_BET_SIZES"),
        ("starting_pot", json!(0), "INVALID_STACKS"),
    ];
    for (field, value, reason) in cases {
        let mut body = tiny_river();
        body[field] = value;
        let (status, v) = post(AppState::new(settings()), body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{field}: {v}");
        assert_eq!(v["reason"], reason, "{field}");
    }

    let mut body = tiny_river();
    body.as_object_mut().unwrap().remove("board");
    let (status, v) = post(AppState::new(settings()), body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["reason"], "INVALID_REQUEST");
}

#[tokio::test]
async fn memory_limit_gives_tree_too_large() {
    let s = Settings { max_memory_mb: 0, ..settings() };
    let (status, v) = post(AppState::new(s), tiny_river()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["reason"], "TREE_TOO_LARGE");
}

/// Regression: 7 bet / 3 raise sizes on a 200bb flop used to build the whole tree and
/// node arena (tens of GB) before the memory check, so the process was OOM-killed. The
/// pre-check must reject it from the config alone, in well under a second.
#[tokio::test]
async fn huge_flop_tree_rejected_before_allocating() {
    let street = json!({"bet": "25%, 33%, 50%, 75%, 100%, 125%, 150%", "raise": "2x, 3x, 4x"});
    let mut body = tiny_river();
    body["board"] = json!("Td9d6h");
    body["oop_range"] = json!(SRP_OOP);
    body["ip_range"] = json!(SRP_IP);
    body["starting_pot"] = json!(550);
    body["effective_stack"] = json!(19750);
    body["bet_sizes"] = json!({"flop": street, "turn": street, "river": street});
    let s = Settings { max_memory_mb: 1024, ..settings() };
    let start = std::time::Instant::now();
    let (status, v) = post(AppState::new(s), body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert_eq!(v["status"], "cant_solve");
    assert_eq!(v["reason"], "TREE_TOO_LARGE");
    assert!(start.elapsed() < Duration::from_secs(5), "took {:?}", start.elapsed());
}

#[tokio::test]
async fn expired_deadline_gives_timeout() {
    let s = Settings { solve_timeout: Duration::ZERO, ..settings() };
    let mut body = tiny_river();
    body["target_exploitability_pct"] = json!(0.0);
    let (status, v) = post(AppState::new(s), body).await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT, "{v}");
    assert_eq!(v["reason"], "TIMEOUT");
}

#[tokio::test]
async fn busy_when_permit_taken_and_queueing_disabled() {
    let state = AppState::new(Settings { queue_max_waiting: 0, ..settings() });
    let _held = state.queue.try_acquire().unwrap();
    let (status, v) = post(state, tiny_river()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(v["reason"], "SOLVER_BUSY");
}

// ---------- queue ----------

fn queue_settings(max_waiting: usize, max_wait: Duration) -> Settings {
    Settings { queue_max_waiting: max_waiting, queue_max_wait: max_wait, ..settings() }
}

/// Waits (up to 2s) until `n` requests are waiting in line.
async fn until_waiting(state: &AppState, n: usize) {
    for _ in 0..200 {
        if state.queue.waiting() == n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("expected {n} waiting, have {}", state.queue.waiting());
}

fn solve_request(body: &Value, ndjson: bool) -> Request<Body> {
    let mut req = Request::builder().method("POST").uri("/solve").header("content-type", "application/json");
    if ndjson {
        req = req.header("accept", "application/x-ndjson");
    }
    req.body(Body::from(body.to_string())).unwrap()
}

/// Reads NDJSON lines from a streamed body until it ends.
struct Lines {
    body: Body,
    buf: Vec<u8>,
}

impl Lines {
    fn new(resp: axum::response::Response) -> Self {
        assert_eq!(resp.headers()["content-type"], "application/x-ndjson");
        Self { body: resp.into_body(), buf: Vec::new() }
    }

    async fn next(&mut self) -> Option<Value> {
        loop {
            if let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.buf.drain(..=i).collect();
                return Some(serde_json::from_slice(&line).expect("each line is JSON"));
            }
            let frame = self.body.frame().await?.unwrap();
            if let Ok(data) = frame.into_data() {
                self.buf.extend_from_slice(&data);
            }
        }
    }

    async fn rest(mut self) -> Vec<Value> {
        let mut out = Vec::new();
        while let Some(v) = self.next().await {
            out.push(v);
        }
        out
    }
}

/// Event types with consecutive repeats (heartbeats) collapsed, e.g. ["queued:2", "queued:1", "solving", "result"].
fn timeline(events: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in events {
        let t = match e["type"].as_str().unwrap() {
            "queued" => format!("queued:{}", e["position"]),
            other => other.to_string(),
        };
        if out.last() != Some(&t) {
            out.push(t);
        }
    }
    out
}

#[tokio::test]
async fn ndjson_runs_immediately_when_idle() {
    let state = AppState::new(settings());
    let resp = router(state.clone()).oneshot(solve_request(&tiny_river(), true)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let events = Lines::new(resp).rest().await;
    assert_eq!(timeline(&events), ["solving", "result"]);
    let last = events.last().unwrap();
    assert_eq!(last["status"], "ok");
    assert_frequencies_sum_to_one(last);
    assert!(!state.queue.is_running());
}

#[tokio::test]
async fn queued_requests_run_in_order_with_positions() {
    let state = AppState::new(queue_settings(5, Duration::from_secs(30)));
    let held = state.queue.try_acquire().unwrap();

    let mut streams = Vec::new();
    for n in 0..3 {
        let mut body = tiny_river();
        body["max_iterations"] = json!(20 + n);
        let resp = router(state.clone()).oneshot(solve_request(&body, true)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let mut lines = Lines::new(resp);
        // First line: place in line, set at join time.
        assert_eq!(lines.next().await.unwrap(), json!({"type": "queued", "position": n + 1}));
        streams.push(lines);
    }
    assert_eq!(state.queue.waiting(), 3);

    drop(held);
    // Position n+1 counting down to 1 before "solving" means request n ran n-th.
    for (n, lines) in streams.into_iter().enumerate() {
        let events = lines.rest().await;
        let mut expected: Vec<String> = (1..=n).rev().map(|p| format!("queued:{p}")).collect();
        expected.extend(["solving".into(), "result".into()]);
        assert_eq!(timeline(&events), expected, "request {n}");
        assert_eq!(events.last().unwrap()["status"], "ok");
    }
    assert_eq!(state.queue.waiting(), 0);
    assert!(!state.queue.is_running());
}

#[tokio::test]
async fn full_queue_is_busy_but_bad_input_still_422() {
    let state = AppState::new(queue_settings(1, Duration::from_secs(30)));
    let held = state.queue.try_acquire().unwrap();

    // Takes the only waiting place.
    let waiter = tokio::spawn(post(state.clone(), tiny_river()));
    until_waiting(&state, 1).await;

    let start = std::time::Instant::now();
    let (status, v) = post(state.clone(), tiny_river()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
    assert_eq!(v["reason"], "SOLVER_BUSY");
    assert!(v["message"].as_str().unwrap().contains("queue is full"), "{v}");
    let resp = router(state.clone()).oneshot(solve_request(&tiny_river(), true)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE, "NDJSON callers get the plain 503 too");

    let mut bad = tiny_river();
    bad["board"] = json!("Td9d6hTd2s");
    let (status, v) = post(state.clone(), bad.clone()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["reason"], "INVALID_BOARD");
    let resp = router(state.clone()).oneshot(solve_request(&bad, true)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(start.elapsed() < Duration::from_secs(1));

    // The waiter is served once the slot frees up.
    drop(held);
    let (status, v) = waiter.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{v}");
}

#[tokio::test]
async fn wait_timeout_is_busy() {
    let state = AppState::new(queue_settings(5, Duration::from_millis(200)));
    let _held = state.queue.try_acquire().unwrap();

    let start = std::time::Instant::now();
    let (status, v) = post(state.clone(), tiny_river()).await;
    assert!(start.elapsed() >= Duration::from_millis(200));
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(v["reason"], "SOLVER_BUSY");
    assert_eq!(v["message"], "Can't solve this right now: queue timed out. Try again shortly.");

    let resp = router(state.clone()).oneshot(solve_request(&tiny_river(), true)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let events = Lines::new(resp).rest().await;
    assert_eq!(timeline(&events), ["queued:1", "error"]);
    let last = events.last().unwrap();
    assert_eq!(last["status"], "cant_solve");
    assert_eq!(last["reason"], "SOLVER_BUSY");
    assert_eq!(last["message"], "Can't solve this right now: queue timed out. Try again shortly.");
    assert_eq!(state.queue.waiting(), 0);
}

#[tokio::test]
async fn disconnect_while_waiting_frees_the_place() {
    let state = AppState::new(queue_settings(1, Duration::from_secs(30)));
    let held = state.queue.try_acquire().unwrap();

    // Streaming client reads its position, then hangs up.
    let resp = router(state.clone()).oneshot(solve_request(&tiny_river(), true)).await.unwrap();
    let mut lines = Lines::new(resp);
    assert_eq!(lines.next().await.unwrap()["position"], 1);
    assert_eq!(state.queue.waiting(), 1);
    drop(lines);
    until_waiting(&state, 0).await;

    // Plain-JSON client: dropping the in-flight request future leaves the line.
    let task = tokio::spawn(post(state.clone(), tiny_river()));
    until_waiting(&state, 1).await;
    task.abort();
    let _ = task.await;
    until_waiting(&state, 0).await;

    // The freed place is usable, and the slot itself was never lost.
    let next = tokio::spawn(post(state.clone(), tiny_river()));
    until_waiting(&state, 1).await;
    drop(held);
    let (status, v) = next.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{v}");
}

#[tokio::test]
async fn plain_json_waits_its_turn() {
    let state = AppState::new(queue_settings(5, Duration::from_secs(30)));
    let held = state.queue.try_acquire().unwrap();
    let task = tokio::spawn(post(state.clone(), tiny_river()));
    until_waiting(&state, 1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!task.is_finished());
    drop(held);
    let (status, v) = task.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_frequencies_sum_to_one(&v);
}

#[tokio::test]
async fn auth_required_except_health_when_key_set() {
    let state = AppState::new(keyed_settings());

    let (status, v) = send(state.clone(), "GET", "/health", None, None).await;
    assert_eq!((status, v), (StatusCode::OK, json!("ok")));

    for key in [None, Some("wrong"), Some("test-key-012345678")] {
        let (status, v) = send(state.clone(), "POST", "/solve", key, Some(tiny_river())).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{key:?}");
        assert_eq!(v["status"], "cant_solve");
        assert_eq!(v["reason"], "UNAUTHORIZED");
        let (status, v) = admit(&state, key, "1.2.3.4").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(v["reason"], "UNAUTHORIZED");
    }

    let (status, v) = send(state.clone(), "POST", "/solve", Some(KEY), Some(tiny_river())).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let (status, v) = admit(&state, Some(KEY), "1.2.3.4").await;
    assert_eq!((status, v), (StatusCode::OK, json!({"status": "ok"})));
}

#[tokio::test]
async fn auth_disabled_without_key() {
    let state = AppState::new(settings());
    let (status, _) = admit(&state, None, "1.2.3.4").await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn admit_limits_per_ip_then_global() {
    let s = Settings { rate_limit_per_ip_hour: 10, rate_limit_global_day: 15, ..keyed_settings() };
    let state = AppState::new(s);
    for i in 0..10 {
        let (status, v) = admit(&state, Some(KEY), "203.0.113.7").await;
        assert_eq!(status, StatusCode::OK, "admit {i}: {v}");
    }
    let (status, v) = admit(&state, Some(KEY), "203.0.113.7").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(v["status"], "cant_solve");
    assert_eq!(v["reason"], "RATE_LIMITED");

    for i in 0..5 {
        let (status, _) = admit(&state, Some(KEY), &format!("198.51.100.{i}")).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, v) = admit(&state, Some(KEY), "192.0.2.1").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(v["reason"], "RATE_LIMITED");
}

#[tokio::test]
async fn admit_rejects_bad_bodies() {
    let state = AppState::new(settings());
    let (status, v) = admit(&state, None, "  ").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["reason"], "INVALID_REQUEST");
    let (status, v) = send(state, "POST", "/admit", None, Some(json!({"addr": "x"}))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["reason"], "INVALID_REQUEST");
}

/// Full srp river spot from the M1 acceptance criteria. Slow in debug builds.
#[tokio::test]
#[ignore]
async fn srp_river_spot() {
    let mut body = tiny_river();
    body["oop_range"] = json!(SRP_OOP);
    body["ip_range"] = json!(SRP_IP);
    body["max_iterations"] = json!(1000);
    let (status, v) = post(AppState::new(settings()), body).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_frequencies_sum_to_one(&v);
}

/// Flop spot with a slim bet tree (~520 MB, ~7s in release). Run with `--ignored --release`.
/// Note: the full default sizes (33%/75%, 3x raises every street) need ~20 GB raw /
/// ~10 GB compressed on this flop, i.e. TREE_TOO_LARGE at the 4096 MB test cap.
#[tokio::test]
#[ignore]
async fn srp_flop_spot() {
    let mut body = tiny_river();
    body["board"] = json!("Td9d6h");
    body["oop_range"] = json!(SRP_OOP);
    body["ip_range"] = json!(SRP_IP);
    body["max_iterations"] = json!(1000);
    body["bet_sizes"] = json!({
        "flop":  {"bet": "50%", "raise": ""},
        "turn":  {"bet": "75%", "raise": ""},
        "river": {"bet": "75%", "raise": ""}
    });
    let s = Settings { solve_timeout: Duration::from_secs(300), ..settings() };
    let (status, v) = post(AppState::new(s), body).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_frequencies_sum_to_one(&v);
}
