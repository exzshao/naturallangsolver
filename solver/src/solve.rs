//! Size pre-check, build the game, check memory, run the CFR loop with a deadline (SPEC §8).
//! With a `line`, stage 1 (`line.rs`) narrows both ranges first; both stages share one
//! deadline. Everything here is blocking and CPU-bound; call it from `spawn_blocking`.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::Instant;

use postflop_solver::{
    Action, ActionTree, CardConfig, PostFlopGame, Range, TreeConfig, compute_exploitability, finalize, solve_step,
};

use crate::api::{SolveResponse, StreetLine, TreeChoice};
use crate::config::{HeroSpec, Prepared, Settings, TreeCandidate};
use crate::error::{Reason, SolveError};
use crate::line::{self, LineStatus};
use crate::street::{self, StreetPlan, StreetStatus};
use crate::summary;
use crate::tree_size;

const MIB: f64 = 1024.0 * 1024.0;

/// What the solve is doing, for streamed status lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Stage 1: the simplified flop solve of the line.
    Narrowing,
    /// Stage 2 (or the only stage): the current street.
    Solving,
}

/// A built, allocated and solved (not finalized) game.
pub struct Solved {
    pub game: PostFlopGame,
    pub iterations: u32,
    /// Chips.
    pub exploitability: f32,
    pub timed_out: bool,
    pub memory_bytes: u64,
    pub compressed: bool,
}

/// Pre-checks the tree size, builds the game, picks raw or compressed storage under
/// `max_memory_mb`, and runs CFR until `target_pct` (of the starting pot),
/// `max_iters`, or `deadline`. A missed deadline is reported in `timed_out`, not as an
/// error; callers decide.
pub fn build_and_solve(
    tree_config: TreeConfig,
    card_config: CardConfig,
    target_pct: f64,
    max_iters: u32,
    deadline: Instant,
    max_memory_mb: u64,
) -> Result<Solved, SolveError> {
    build_and_solve_with(tree_config, card_config, &[], target_pct, max_iters, deadline, max_memory_mb, |_| {})
}

/// [`build_and_solve`] with lines added to the action tree (`ActionTree::add_line`; lines
/// the tree can't take are skipped) and a hook that runs on the allocated, unsolved game
/// (e.g. to lock strategies); the game is put back at the root after it.
#[allow(clippy::too_many_arguments)]
pub fn build_and_solve_with(
    tree_config: TreeConfig,
    card_config: CardConfig,
    extra_lines: &[Vec<Action>],
    target_pct: f64,
    max_iters: u32,
    deadline: Instant,
    max_memory_mb: u64,
    before_solve: impl FnOnce(&mut PostFlopGame),
) -> Result<Solved, SolveError> {
    let starting_pot = tree_config.starting_pot;
    let limit = max_memory_mb.saturating_mul(1024 * 1024);

    // `ActionTree::new` and `with_config` allocate the whole tree / node arena before
    // `memory_usage()` can be asked, so reject big trees from the config alone first.
    if let Some(est) = tree_size::estimate(&tree_config, limit)
        && est.exceeded
    {
        return Err(SolveError::new(
            Reason::TreeTooLarge,
            format!(
                "pre-check: tree + node arena over {max_memory_mb} MB after {:?} action nodes (flop, turn, river)",
                est.action_nodes
            ),
        ));
    }

    let mut tree = ActionTree::new(tree_config).map_err(SolveError::from_crate)?;
    for l in extra_lines {
        if let Err(e) = tree.add_line(l) {
            tracing::debug!("skipped extra line {l:?}: {e}");
        }
    }
    let mut game = PostFlopGame::with_config(card_config, tree).map_err(SolveError::from_crate)?;

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
                "needs {:.1} MB raw / {:.1} MB compressed, limit {max_memory_mb} MB",
                raw as f64 / MIB,
                compressed_bytes as f64 / MIB,
            ),
        ));
    };
    game.allocate_memory(compressed);
    let memory_bytes = if compressed { compressed_bytes } else { raw };
    before_solve(&mut game);
    game.back_to_root();

    // Own iteration loop so the deadline can be enforced.
    let target = starting_pot as f32 * (target_pct as f32) / 100.0;
    let max_iters = max_iters.max(1);
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

    Ok(Solved { game, iterations, exploitability, timed_out, memory_bytes, compressed })
}

/// The stage-2 tree [`pick_tree`] chose.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Picked {
    pub index: usize,
    pub estimated_secs: f64,
    pub raw_mb: f64,
    /// No tree was estimated within the budget; this is the cheapest one that fits memory.
    pub over_budget: bool,
}

/// Rough stage-2 solve time for a tree with `raw_bytes` of (uncompressed) storage.
pub fn estimate_secs(raw_bytes: u64, settings: &Settings) -> f64 {
    raw_bytes as f64 / MIB * settings.tree_ms_per_mb / 1000.0
}

/// Picks the stage-2 tree (SPEC §7 "Tree budget"): the first of `trees` (richest first)
/// whose storage fits `MAX_MEMORY_MB` (raw or compressed) and whose estimated solve time
/// ([`estimate_secs`]) fits `TREE_BUDGET_SECS`. If none is within the budget, the
/// cheapest one that fits memory; if none fits memory, `TREE_TOO_LARGE`. Each tree is
/// built (action tree + node arena, after the size pre-check) to read its storage size,
/// then dropped: ~0.1 s per flop tree.
pub fn pick_tree(trees: &[TreeCandidate], card_config: &CardConfig, settings: &Settings) -> Result<Picked, SolveError> {
    let limit = settings.max_memory_mb.saturating_mul(1024 * 1024);
    let mut cheapest: Option<Picked> = None;
    let mut last_err = None;
    for (index, t) in trees.iter().enumerate() {
        if let Some(est) = tree_size::estimate(&t.tree_config, limit)
            && est.exceeded
        {
            last_err = Some(SolveError::new(
                Reason::TreeTooLarge,
                format!(
                    "pre-check: tree + node arena over {} MB after {:?} action nodes (flop, turn, river)",
                    settings.max_memory_mb, est.action_nodes
                ),
            ));
            continue;
        }
        let mut tree = ActionTree::new(t.tree_config.clone()).map_err(SolveError::from_crate)?;
        if let StreetStatus::Plan(p) = &t.street {
            for l in &p.extra_lines {
                let _ = tree.add_line(l);
            }
        }
        let game = PostFlopGame::with_config(card_config.clone(), tree).map_err(SolveError::from_crate)?;
        let (raw, compressed) = game.memory_usage();
        if compressed > limit {
            last_err = Some(SolveError::new(
                Reason::TreeTooLarge,
                format!(
                    "needs {:.1} MB raw / {:.1} MB compressed, limit {} MB",
                    raw as f64 / MIB,
                    compressed as f64 / MIB,
                    settings.max_memory_mb
                ),
            ));
            continue;
        }
        let estimated_secs = estimate_secs(raw, settings);
        let picked = Picked { index, estimated_secs, raw_mb: raw as f64 / MIB, over_budget: false };
        if estimated_secs <= settings.tree_budget_secs {
            return Ok(picked);
        }
        tracing::info!(tree = index, estimated_secs, "tree over the time budget; trying a simpler one");
        if cheapest.is_none_or(|c| estimated_secs < c.estimated_secs) {
            cheapest = Some(Picked { over_budget: true, ..picked });
        }
    }
    cheapest.ok_or_else(|| last_err.unwrap_or_else(|| SolveError::new(Reason::TreeTooLarge, "no tree to solve")))
}

pub fn run(prep: Prepared, settings: &Settings) -> Result<SolveResponse, SolveError> {
    run_with(prep, settings, |_| {})
}

/// Like [`run`], calling `on_phase(Phase::Solving)` when stage 2 starts after a
/// stage-1 attempt (the caller announces the first phase itself).
pub fn run_with(prep: Prepared, settings: &Settings, on_phase: impl Fn(Phase)) -> Result<SolveResponse, SolveError> {
    let start = Instant::now();
    let deadline = start + settings.solve_timeout;
    let Prepared {
        card_config,
        trees,
        given_trees,
        hero,
        max_iterations,
        target_exploitability_pct,
        line,
        villain_known,
    } = prep;
    let starting_pot = trees[0].tree_config.starting_pot;

    // Stage 1. Never fails the request: problems become a skip reason.
    let mut ranges = card_config.range;
    let mut narrowing = match line {
        LineStatus::None => None,
        LineStatus::Skip(reason) => Some(line::skipped(reason, 0)),
        LineStatus::Plan(plan) => {
            let stage_deadline = (start + settings.solve_timeout.mul_f64(line::STAGE1_TIME_SHARE)).min(deadline);
            let result = catch_unwind(AssertUnwindSafe(|| {
                line::narrow(*plan, hero.as_ref(), settings.max_memory_mb, settings.rare_line_threshold, stage_deadline)
            }));
            let elapsed = start.elapsed().as_millis() as u64;
            let n = match result {
                Ok(Ok(n)) => {
                    ranges = n.ranges;
                    n.summary
                }
                Ok(Err(reason)) => line::skipped(reason, elapsed),
                Err(_) => line::skipped("the flop solve hit an internal error".into(), elapsed),
            };
            tracing::info!(
                narrowed = n.narrowed,
                reason = n.reason.as_deref().unwrap_or(""),
                stage1_ms = n.solve_ms,
                iterations = n.iterations.unwrap_or(0),
                memory_mb = n.memory_mb.unwrap_or(0.0),
                "line narrowing finished"
            );
            on_phase(Phase::Solving);
            Some(n)
        }
    };
    let narrowed = narrowing.as_ref().is_some_and(|n| n.narrowed);

    // Stage-2 tree: the richest one estimated within the time budget and memory.
    let pick_with = |range: [Range; 2]| pick_tree(&trees, &CardConfig { range, ..card_config.clone() }, settings);
    let picked = match pick_with(ranges) {
        Err(e) if narrowed && e.reason == Reason::InvalidRange => {
            narrowing = Some(line::skipped(
                "the narrowed ranges couldn't be used".into(),
                narrowing.as_ref().map_or(0, |n| n.solve_ms),
            ));
            ranges = card_config.range;
            pick_with(ranges)?
        }
        r => r?,
    };
    let narrowed = narrowing.as_ref().is_some_and(|n| n.narrowed);
    let TreeCandidate { sizes: tree_sizes, auto, tree_config, street } = trees[picked.index].clone();
    tracing::info!(
        tree = picked.index,
        auto = auto.unwrap_or(""),
        estimated_secs = picked.estimated_secs,
        raw_mb = picked.raw_mb,
        over_budget = picked.over_budget,
        "stage-2 tree picked"
    );

    // Current-street actions: walked before the solve (to lock) and after (to report).
    let (mut plan, mut street_reason) = match street {
        StreetStatus::None => (None, None),
        StreetStatus::Skip(r) => (None, Some(r)),
        StreetStatus::Plan(p) => (Some(p), None),
    };
    let had_street = plan.is_some() || street_reason.is_some();
    // Players whose whole range is locked into the street actions.
    let mut full_lock = [false; 2];
    if let Some(v) = villain_known {
        full_lock[v] = true;
    }

    // Stage 2: the current street.
    let target = starting_pot as f32 * (target_exploitability_pct as f32) / 100.0;
    let stage2 = |range: [Range; 2], plan: Option<&StreetPlan>, full: [bool; 2]| {
        let mut walk_err = None;
        let solved = build_and_solve_with(
            tree_config.clone(),
            CardConfig { range, ..card_config.clone() },
            plan.map_or(&[][..], |p| p.extra_lines.as_slice()),
            target_exploitability_pct,
            max_iterations,
            deadline,
            settings.max_memory_mb,
            |game| {
                if let Some(p) = plan {
                    walk_err = lock_street(game, p, hero.as_ref(), full).err();
                }
            },
        )?;
        if solved.timed_out && solved.exploitability > target * 3.0 {
            return Err(SolveError::new(
                Reason::Timeout,
                format!(
                    "deadline hit after {} iterations, exploitability {:.3}% of pot (target {:.3}%)",
                    solved.iterations,
                    solved.exploitability / starting_pot as f32 * 100.0,
                    target_exploitability_pct
                ),
            ));
        }
        Ok((solved, walk_err))
    };
    let mut used_ranges = ranges;
    let (mut solved, walk_err) = match stage2(ranges, plan.as_ref(), full_lock) {
        // Narrowed ranges the game can't use (e.g. no valid card assignment): solve
        // from the request's ranges instead.
        Err(e) if narrowed && e.reason == Reason::InvalidRange => {
            narrowing = Some(line::skipped(
                "the narrowed ranges couldn't be used".into(),
                narrowing.as_ref().map_or(0, |n| n.solve_ms),
            ));
            used_ranges = card_config.range;
            stage2(card_config.range, plan.as_ref(), full_lock)?
        }
        r => r?,
    };
    if let Some(e) = walk_err {
        street_reason = Some(e);
        plan = None;
    }
    finalize(&mut solved.game);

    // Read hero's decision after the street actions. If villain's solved range (almost)
    // never takes them, re-solve with villain's whole range locked into them.
    let mut sizes = plan.as_ref().map(|p| p.sizes.clone()).unwrap_or_default();
    let mut villain_rare = false;
    let mut street_read = None;
    if let Some(p) = plan.as_ref() {
        let villain = p.hero ^ 1;
        match summary::extract_street(&mut solved.game, hero.as_ref(), p, &mut sizes, &used_ranges, full_lock[villain]) {
            Ok(x) if !full_lock[villain] && x.villain_weight < street::MIN_LINE_COMBOS => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left < settings.solve_timeout.mul_f64(street::RESOLVE_TIME_SHARE) {
                    street_reason = Some("villain's range almost never takes this line in the solve, and there was no time to re-solve".into());
                } else {
                    tracing::info!(villain_weight = x.villain_weight, "villain rarely takes the street line; re-solving locked");
                    villain_rare = true;
                    full_lock[villain] = true;
                    drop(solved);
                    let (again, err) = stage2(used_ranges, Some(p), full_lock)?;
                    solved = again;
                    finalize(&mut solved.game);
                    let read = err.map_or_else(
                        || summary::extract_street(&mut solved.game, hero.as_ref(), p, &mut sizes, &used_ranges, true),
                        Err,
                    );
                    match read {
                        Ok(x) => street_read = Some(x),
                        Err(e) => street_reason = Some(e),
                    }
                }
            }
            Ok(x) => street_read = Some(x),
            Err(e) => street_reason = Some(e),
        }
    }
    let Solved { mut game, iterations, exploitability, timed_out, memory_bytes, compressed } = solved;

    let matched = street_read.is_some();
    let (players, nodes, hero_hand, villain_range) = match street_read {
        Some(x) => (x.players, x.nodes, x.hero_hand, Some(x.villain_range)),
        None => {
            let (p, n, h) = summary::extract(&mut game, hero.as_ref())?;
            (p, n, h, None)
        }
    };
    let street_line = had_street.then(|| StreetLine {
        matched,
        reason: if matched { None } else { street_reason.clone() },
        sizes: if matched { sizes } else { Vec::new() },
        villain_locked: matched && plan.as_ref().is_some_and(|p| full_lock[p.hero ^ 1]),
        villain_rare: matched && villain_rare,
        villain_range,
    });

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
        narrowing,
        street_line,
        tree: Some(TreeChoice {
            index: picked.index,
            given: given_trees,
            auto: auto.map(Into::into),
            bet_sizes: tree_sizes,
            estimated_secs: round(picked.estimated_secs, 2),
            raw_mb: round(picked.raw_mb, 2),
            over_budget: picked.over_budget,
        }),
    };
    tracing::info!(
        iterations,
        exploitability_pct = resp.exploitability_pct,
        solve_ms = resp.solve_ms,
        memory_mb = resp.memory_mb,
        compressed,
        timed_out,
        street_matched = matched,
        street_reason = street_reason.as_deref().unwrap_or(""),
        "solve finished"
    );
    Ok(resp)
}

/// Before the solve: checks the street actions are in the tree, then locks hero's exact
/// hand into hero's actions (so it reaches the decision with weight) and, for players in
/// `full`, the whole range. Leaves the game unlocked if the walk fails.
fn lock_street(game: &mut PostFlopGame, plan: &StreetPlan, hero: Option<&HeroSpec>, full: [bool; 2]) -> Result<(), String> {
    let mut sizes = plan.sizes.clone();
    street::walk(game, plan, &mut sizes, |_, _, _| {})?;
    street::walk(game, plan, &mut sizes, |game, player, action| {
        let hand = hero
            .filter(|h| h.player.index() == player)
            .and_then(|h| game.private_cards(player).iter().position(|&c| c == h.cards));
        if let Some(row) = street::lock_row(game, player, action, full[player], hand) {
            game.lock_current_strategy(&row);
        }
    })
}

pub(crate) fn round(x: f64, decimals: i32) -> f64 {
    if !x.is_finite() {
        return 0.0;
    }
    let m = 10f64.powi(decimals);
    (x * m).round() / m
}
