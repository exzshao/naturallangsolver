//! Size pre-check, build the game, check memory, run the CFR loop with a deadline (SPEC §8).
//! Everything here is blocking and CPU-bound; call it from `spawn_blocking`.

use std::time::Instant;

use postflop_solver::{ActionTree, PostFlopGame, compute_exploitability, finalize, solve_step};

use crate::api::SolveResponse;
use crate::config::{Prepared, Settings};
use crate::error::{Reason, SolveError};
use crate::summary;
use crate::tree_size;

const MIB: f64 = 1024.0 * 1024.0;

pub fn run(prep: Prepared, settings: &Settings) -> Result<SolveResponse, SolveError> {
    let start = Instant::now();
    let deadline = start + settings.solve_timeout;

    let starting_pot = prep.tree_config.starting_pot;
    let limit = settings.max_memory_mb.saturating_mul(1024 * 1024);

    // `ActionTree::new` and `with_config` allocate the whole tree / node arena before
    // `memory_usage()` can be asked, so reject big trees from the config alone first.
    if let Some(est) = tree_size::estimate(&prep.tree_config, limit)
        && est.exceeded
    {
        return Err(SolveError::new(
            Reason::TreeTooLarge,
            format!(
                "pre-check: tree + node arena over {} MB after {:?} action nodes (flop, turn, river)",
                settings.max_memory_mb, est.action_nodes
            ),
        ));
    }

    let tree = ActionTree::new(prep.tree_config).map_err(SolveError::from_crate)?;
    let mut game =
        PostFlopGame::with_config(prep.card_config, tree).map_err(SolveError::from_crate)?;

    // Full memory check (solver storage) before allocating it.
    let (raw, compressed_bytes) = game.memory_usage();
    let compressed = if raw <= limit {
        false
    } else if compressed_bytes <= limit {
        true
    } else {
        return Err(SolveError::new(
            Reason::TreeTooLarge,
            format!(
                "needs {:.1} MB raw / {:.1} MB compressed, limit {} MB",
                raw as f64 / MIB,
                compressed_bytes as f64 / MIB,
                settings.max_memory_mb
            ),
        ));
    };
    game.allocate_memory(compressed);
    let memory_bytes = if compressed { compressed_bytes } else { raw };

    // Own iteration loop so the deadline can be enforced.
    let target = starting_pot as f32 * (prep.target_exploitability_pct as f32) / 100.0;
    let max_iters = prep.max_iterations.max(1);
    let mut iterations = 0u32;
    let mut exploitability = f32::INFINITY;
    let mut timed_out = false;
    for i in 0..max_iters {
        solve_step(&game, i);
        iterations = i + 1;
        let past_deadline = Instant::now() >= deadline;
        if iterations.is_multiple_of(10) || iterations == max_iters || past_deadline {
            exploitability = compute_exploitability(&game);
            if exploitability <= target {
                break;
            }
            if past_deadline {
                timed_out = true;
                break;
            }
        }
    }

    if timed_out && exploitability > target * 3.0 {
        return Err(SolveError::new(
            Reason::Timeout,
            format!(
                "deadline hit after {iterations} iterations, exploitability {:.3}% of pot (target {:.3}%)",
                exploitability / starting_pot as f32 * 100.0,
                prep.target_exploitability_pct
            ),
        ));
    }

    finalize(&mut game);

    let (players, nodes, hero_hand) = summary::extract(&mut game, prep.hero.as_ref())?;

    let resp = SolveResponse {
        status: "ok".into(),
        exploitability_pct: round(exploitability as f64 / starting_pot as f64 * 100.0, 4),
        iterations,
        solve_ms: start.elapsed().as_millis() as u64,
        memory_mb: round(memory_bytes as f64 / MIB, 1),
        compressed,
        players,
        nodes,
        hero_hand,
    };
    tracing::info!(
        iterations,
        exploitability_pct = resp.exploitability_pct,
        solve_ms = resp.solve_ms,
        memory_mb = resp.memory_mb,
        compressed,
        timed_out,
        "solve finished"
    );
    Ok(resp)
}

pub(crate) fn round(x: f64, decimals: i32) -> f64 {
    if !x.is_finite() {
        return 0.0;
    }
    let m = 10f64.powi(decimals);
    (x * m).round() / m
}
