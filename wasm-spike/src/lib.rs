//! Spike: run the same postflop-solver spots natively and in the browser (wasm32 +
//! threads + SIMD) and report timings. `run_spot` is shared by both builds.

use postflop_solver::{
    compute_exploitability, solve_step, ActionTree, BetSizeOptions, BoardState, CardConfig,
    PostFlopGame, TreeConfig, NOT_DEALT,
};
use serde::{Deserialize, Serialize};
use web_time::Instant;

#[derive(Debug, Clone, Deserialize)]
pub struct Spot {
    pub name: String,
    /// 3-5 cards, e.g. "Td9d6hQc2s".
    pub board: String,
    pub oop_range: String,
    pub ip_range: String,
    pub starting_pot: i32,
    pub effective_stack: i32,
    /// [bet, raise] per street.
    pub flop: [String; 2],
    pub turn: [String; 2],
    pub river: [String; 2],
    pub max_iterations: u32,
    /// Percent of the starting pot.
    pub target_pct: f32,
    /// Force compressed (16-bit) storage.
    #[serde(default)]
    pub compressed: bool,
    /// Only build the tree and report memory; no allocation, no solve.
    #[serde(default)]
    pub size_only: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub name: String,
    pub threads: usize,
    pub build_ms: f64,
    pub alloc_ms: f64,
    pub solve_ms: f64,
    pub iterations: u32,
    pub ms_per_iter: f64,
    pub exploitability_pct: f64,
    pub raw_mb: f64,
    pub compressed_mb: f64,
    pub compressed: bool,
}

const MIB: f64 = 1024.0 * 1024.0;

fn cards(s: &str) -> Result<Vec<u8>, String> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    s.as_bytes()
        .chunks(2)
        .map(|c| postflop_solver::card_from_str(std::str::from_utf8(c).unwrap()))
        .collect()
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// Builds, allocates and solves `spot`, calling `progress(iteration, exploitability_pct,
/// elapsed_ms)` every 10 iterations.
pub fn run_spot(spot: &Spot, mut progress: impl FnMut(u32, f64, f64)) -> Result<Report, String> {
    let b = cards(&spot.board)?;
    if !(3..=5).contains(&b.len()) {
        return Err("board needs 3-5 cards".into());
    }
    let mut flop = [b[0], b[1], b[2]];
    flop.sort_unstable();
    let turn = b.get(3).copied().unwrap_or(NOT_DEALT);
    let river = b.get(4).copied().unwrap_or(NOT_DEALT);
    let state = match b.len() {
        3 => BoardState::Flop,
        4 => BoardState::Turn,
        _ => BoardState::River,
    };
    let sizes = |s: &[String; 2]| BetSizeOptions::try_from((s[0].as_str(), s[1].as_str()));
    let (fs, ts, rs) = (sizes(&spot.flop)?, sizes(&spot.turn)?, sizes(&spot.river)?);

    let t0 = Instant::now();
    let card_config = CardConfig {
        range: [spot.oop_range.parse()?, spot.ip_range.parse()?],
        flop,
        turn,
        river,
    };
    let tree_config = TreeConfig {
        initial_state: state,
        starting_pot: spot.starting_pot,
        effective_stack: spot.effective_stack,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [fs.clone(), fs],
        turn_bet_sizes: [ts.clone(), ts],
        river_bet_sizes: [rs.clone(), rs],
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 1.5,
        force_allin_threshold: 0.15,
        merging_threshold: 0.1,
    };
    let tree = ActionTree::new(tree_config)?;
    let mut game = PostFlopGame::with_config(card_config, tree)?;
    let build_ms = ms(t0);
    let (raw, comp) = game.memory_usage();

    let mut report = Report {
        name: spot.name.clone(),
        threads: rayon::current_num_threads(),
        build_ms,
        alloc_ms: 0.0,
        solve_ms: 0.0,
        iterations: 0,
        ms_per_iter: 0.0,
        exploitability_pct: f64::NAN,
        raw_mb: raw as f64 / MIB,
        compressed_mb: comp as f64 / MIB,
        compressed: spot.compressed,
    };
    if spot.size_only {
        return Ok(report);
    }

    let t1 = Instant::now();
    game.allocate_memory(spot.compressed);
    report.alloc_ms = ms(t1);

    let pot = spot.starting_pot as f32;
    let target = pot * spot.target_pct / 100.0;
    let t2 = Instant::now();
    let mut expl = f32::INFINITY;
    for i in 0..spot.max_iterations.max(1) {
        solve_step(&game, i);
        report.iterations = i + 1;
        if report.iterations % 10 == 0 || report.iterations == spot.max_iterations {
            expl = compute_exploitability(&game);
            progress(report.iterations, (expl / pot * 100.0) as f64, ms(t2));
            if expl <= target {
                break;
            }
        }
    }
    report.solve_ms = ms(t2);
    report.ms_per_iter = report.solve_ms / report.iterations as f64;
    report.exploitability_pct = (expl / pot * 100.0) as f64;
    Ok(report)
}

/// Spots used by both harnesses (ranges written descending, as the crate needs).
pub fn spots_json() -> &'static str {
    include_str!("../spots.json")
}

#[cfg(target_family = "wasm")]
pub use wasm_bindgen_rayon::init_thread_pool;

#[cfg(target_family = "wasm")]
mod web {
    use super::*;
    use wasm_bindgen::prelude::*;

    /// Runs one spot (JSON `Spot`), returns a JSON `Report`. `on_progress(iter,
    /// exploitability_pct, elapsed_ms)` is called every 10 iterations.
    #[wasm_bindgen]
    pub fn solve_spot(spot_json: &str, on_progress: &js_sys::Function) -> Result<String, JsError> {
        let spot: Spot = serde_json::from_str(spot_json).map_err(|e| JsError::new(&e.to_string()))?;
        let report = run_spot(&spot, |i, e, t| {
            let _ = on_progress.call3(&JsValue::NULL, &i.into(), &e.into(), &t.into());
        })
        .map_err(|e| JsError::new(&e))?;
        Ok(serde_json::to_string(&report).unwrap())
    }

    #[wasm_bindgen]
    pub fn spots() -> String {
        spots_json().to_string()
    }

    /// Current linear memory size in MB.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen]
    pub fn memory_mb() -> f64 {
        (core::arch::wasm32::memory_size::<0>() * 65536) as f64 / MIB
    }
}
