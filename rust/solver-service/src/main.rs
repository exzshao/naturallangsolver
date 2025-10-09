use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use tracing_subscriber::{fmt, EnvFilter};
use tracing_subscriber::prelude::*;

#[tokio::main]
async fn main() {
    let _ = tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env())
        .try_init();

    let app = Router::new()
        .route("/healthz", post(healthz))
        .route("/solve", post(solve));

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], 8080));
    tracing::info!("listening on {}", addr);
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app)
        .await
        .unwrap();
}

async fn healthz() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
struct SolveRequest {
    config: Config,
    options: Options,
    #[serde(default)]
    node_path: Vec<usize>,
    #[serde(default)]
    lock_strategy: Option<Vec<f32>>, // probabilities at current node
}

#[derive(Deserialize)]
struct Config {
    card_config: CardConfigReq,
    tree_config: TreeConfigReq,
}

#[derive(Deserialize)]
struct CardConfigReq {
    range: [String; 2],
    flop: String,
    #[serde(default)]
    turn: Option<String>,
    #[serde(default)]
    river: Option<String>,
}

#[derive(Deserialize)]
struct TreeConfigReq {
    starting_pot: u32,
    effective_stack: u32,
    rake_rate: f32,
    rake_cap: f32,
    flop_bet_sizes: [String; 2],
    turn_bet_sizes: [String; 2],
    river_bet_sizes: [String; 2],
    #[serde(default)]
    turn_donk_sizes: Option<String>,
    #[serde(default)]
    river_donk_sizes: Option<String>,
    #[serde(default)]
    add_allin_threshold: Option<f32>,
    #[serde(default)]
    force_allin_threshold: Option<f32>,
    #[serde(default)]
    merging_threshold: Option<f32>,
}

#[derive(Deserialize)]
struct Options {
    max_iters: usize,
    #[serde(default)]
    target_exploitability: Option<f32>,
    #[serde(default)]
    compressed: Option<bool>,
    #[serde(default)]
    verbose: Option<bool>,
}

#[derive(Serialize)]
struct SolveResponse {
    exploitability: f32,
    available_actions: Vec<String>,
    node_path: Vec<usize>,
    averages: Averages,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct Averages {
    equity_p0: f32,
    equity_p1: f32,
    ev_p0: f32,
    ev_p1: f32,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    code: String,
    message: String,
}

async fn solve(Json(req): Json<SolveRequest>) -> Result<Json<SolveResponse>, (axum::http::StatusCode, Json<ErrorResponse>)> {
    use postflop_solver::*;

    let mut warnings = Vec::new();

    let flop = match flop_from_str(&req.config.card_config.flop) {
        Ok(f) => f,
        Err(_) => return Err(bad_request("INVALID_INPUT", "invalid flop")),
    };
    let turn = match &req.config.card_config.turn {
        Some(s) => Some(card_from_str(s).map_err(|_| bad_request("INVALID_INPUT", "invalid turn"))?.into()),
        None => None,
    };
    let river = match &req.config.card_config.river {
        Some(s) => Some(card_from_str(s).map_err(|_| bad_request("INVALID_INPUT", "invalid river"))?.into()),
        None => None,
    };

    let ranges = [
        req.config.card_config.range[0].parse().map_err(|_| bad_request("INVALID_INPUT", "invalid OOP range"))?,
        req.config.card_config.range[1].parse().map_err(|_| bad_request("INVALID_INPUT", "invalid IP range"))?,
    ];

    let card_config = CardConfig {
        range: ranges,
        flop,
        turn: turn.unwrap_or(NOT_DEALT),
        river: river.unwrap_or(NOT_DEALT),
    };

    let bs = |s: &String| BetSizeOptions::try_from((s.as_str(), s.as_str()));
    let flop_bs = bs(&req.config.tree_config.flop_bet_sizes[0])
        .and_then(|_| BetSizeOptions::try_from((req.config.tree_config.flop_bet_sizes[0].as_str(), req.config.tree_config.flop_bet_sizes[1].as_str())))
        .map_err(|_| bad_request("INVALID_INPUT", "invalid flop bet sizes"))?;
    let turn_bs = BetSizeOptions::try_from((req.config.tree_config.turn_bet_sizes[0].as_str(), req.config.tree_config.turn_bet_sizes[1].as_str()))
        .map_err(|_| bad_request("INVALID_INPUT", "invalid turn bet sizes"))?;
    let river_bs = BetSizeOptions::try_from((req.config.tree_config.river_bet_sizes[0].as_str(), req.config.tree_config.river_bet_sizes[1].as_str()))
        .map_err(|_| bad_request("INVALID_INPUT", "invalid river bet sizes"))?;

    let turn_donk = match &req.config.tree_config.turn_donk_sizes {
        Some(s) => Some(DonkSizeOptions::try_from(s.as_str()).map_err(|_| bad_request("INVALID_INPUT", "invalid turn donk sizes"))?),
        None => None,
    };
    let river_donk = match &req.config.tree_config.river_donk_sizes {
        Some(s) => Some(DonkSizeOptions::try_from(s.as_str()).map_err(|_| bad_request("INVALID_INPUT", "invalid river donk sizes"))?),
        None => None,
    };

    // Convert request numeric types to crate expectations
    let starting_pot_i32 = req.config.tree_config.starting_pot as i32;
    let effective_stack_i32 = req.config.tree_config.effective_stack as i32;
    let rake_rate_f64 = req.config.tree_config.rake_rate as f64;
    let rake_cap_f64 = req.config.tree_config.rake_cap as f64;
    let add_allin_threshold_f64 = req
        .config
        .tree_config
        .add_allin_threshold
        .map(|v| v as f64)
        .unwrap_or(1.5);
    let force_allin_threshold_f64 = req
        .config
        .tree_config
        .force_allin_threshold
        .map(|v| v as f64)
        .unwrap_or(0.15);
    let merging_threshold_f64 = req
        .config
        .tree_config
        .merging_threshold
        .map(|v| v as f64)
        .unwrap_or(0.1);

    let mut tree_config = TreeConfig {
        initial_state: if river != None { BoardState::River } else if turn != None { BoardState::Turn } else { BoardState::Flop },
        starting_pot: starting_pot_i32,
        effective_stack: effective_stack_i32,
        rake_rate: rake_rate_f64,
        rake_cap: rake_cap_f64,
        flop_bet_sizes: [
            BetSizeOptions::try_from((req.config.tree_config.flop_bet_sizes[0].as_str(), req.config.tree_config.flop_bet_sizes[0].as_str())).unwrap_or(flop_bs.clone()),
            BetSizeOptions::try_from((req.config.tree_config.flop_bet_sizes[1].as_str(), req.config.tree_config.flop_bet_sizes[1].as_str())).unwrap_or(flop_bs.clone()),
        ],
        turn_bet_sizes: [turn_bs.clone(), turn_bs.clone()],
        river_bet_sizes: [river_bs.clone(), river_bs.clone()],
        turn_donk_sizes: turn_donk,
        river_donk_sizes: river_donk,
        add_allin_threshold: add_allin_threshold_f64,
        force_allin_threshold: force_allin_threshold_f64,
        merging_threshold: merging_threshold_f64,
    };

    // Construct tree and game
    let action_tree = ActionTree::new(tree_config).map_err(|_| bad_request("INVALID_INPUT", "invalid tree configuration"))?;
    let mut game = PostFlopGame::with_config(card_config, action_tree).map_err(|_| bad_request("INVALID_INPUT", "invalid card configuration"))?;

    // Allocate memory
    game.allocate_memory(req.options.compressed.unwrap_or(false));

    // Optional: apply node path
    for a in &req.node_path {
        if *a >= game.available_actions().len() { return Err(bad_request("INVALID_INPUT", "node_path has invalid action index")); }
        game.play(*a);
    }

    // Optional: lock strategy at current node
    if let Some(lock) = &req.lock_strategy {
        game.lock_current_strategy(lock);
    }

    // Solve
    let target = req.options.target_exploitability.unwrap_or(1e9);
    let max_iters_u32 = (req.options.max_iters).min(u32::MAX as usize) as u32;
    let exploitability = solve(&mut game, max_iters_u32, target, req.options.verbose.unwrap_or(false));

    // Compute averages
    game.cache_normalized_weights();
    let equity_p0 = average(&game.equity(0), game.normalized_weights(0));
    let ev_p0 = average(&game.expected_values(0), game.normalized_weights(0));
    let equity_p1 = average(&game.equity(1), game.normalized_weights(1));
    let ev_p1 = average(&game.expected_values(1), game.normalized_weights(1));

    // Available actions (strings)
    let actions = game.available_actions().iter().map(|a| format!("{:?}", a)).collect::<Vec<_>>();

    let resp = SolveResponse {
        exploitability,
        available_actions: actions,
        node_path: req.node_path,
        averages: Averages { equity_p0, equity_p1, ev_p0, ev_p1 },
        warnings,
    };

    Ok(Json(resp))
}

fn average(values: &[f32], weights: &[f32]) -> f32 {
    let mut s = 0.0f32;
    for (v, w) in values.iter().zip(weights.iter()) { s += v * w; }
    s
}

fn bad_request(code: &str, message: &str) -> (axum::http::StatusCode, Json<ErrorResponse>) {
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(ErrorResponse { error: ErrorBody { code: code.to_string(), message: message.to_string() } }),
    )
}


