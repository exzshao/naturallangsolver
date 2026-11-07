//! HTTP-level tests against the router (no network). Run with `cargo test --release`
//! for speed; the default tests use a tiny river spot so debug builds are fine too.

use std::time::Duration;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
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
    Settings { port: 0, max_memory_mb: 4096, solve_timeout: Duration::from_secs(60), max_iterations: 1000 }
}

async fn post(state: AppState, body: Value) -> (StatusCode, Value) {
    let req = Request::post("/solve")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = router(state).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn assert_frequencies_sum_to_one(v: &Value) {
    let nodes = v["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 2);
    for node in nodes {
        let sum: f64 = node["actions"].as_array().unwrap().iter().map(|a| a["frequency"].as_f64().unwrap()).sum();
        assert!((sum - 1.0).abs() < 1e-3, "node {:?} sums to {sum}", node["line"]);
        for a in node["actions"].as_array().unwrap() {
            assert!(a["top_hands"].as_array().unwrap().len() <= 5);
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
async fn busy_when_permit_taken() {
    let state = AppState::new(settings());
    let _held = state.permits.clone().try_acquire_owned().unwrap();
    let (status, v) = post(state, tiny_river()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(v["reason"], "SOLVER_BUSY");
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
