//! Two-stage "line" solve (SPEC §7-8). When a turn or river spot comes with the
//! betting on earlier postflop streets, stage 1 solves a simplified game from the
//! flop (default sizes plus each size the line used, for the player who used it),
//! walks the line to the start of the current street, and reads both players' range
//! weights there. Stage 2 (`solve.rs`) then
//! solves the current street from those narrowed ranges.
//!
//! Narrowing never fails the request: any problem becomes a skip reason, and the
//! current street is solved from the request's ranges as before.

use std::time::Instant;

use postflop_solver::{
    Action, BetSize, BetSizeOptions, BoardState, DonkSizeOptions, Card, CardConfig, NOT_DEALT, PostFlopGame, Range, TreeConfig,
};
use serde::Deserialize;
use serde_json::Value;

use crate::api::{ClassWeight, LineSize, NarrowedPlayer, NarrowedRanges, Narrowing, PlayerSide, RangeSummary};
use crate::config::HeroSpec;
use crate::error::Reason;
use crate::solve::{self, round};
use crate::summary::class_name;

/// Stage-1 target exploitability, percent of the flop pot (looser than stage 2's 0.5%).
pub const STAGE1_TARGET_PCT: f64 = 1.0;
/// Stage-1 iteration cap (also capped by `MAX_ITERATIONS`).
pub const STAGE1_MAX_ITERATIONS: u32 = 300;
/// Share of `SOLVE_TIMEOUT_SECS` that stage 1 may use; stage 2 gets the rest.
pub const STAGE1_TIME_SHARE: f64 = 0.5;
/// Narrowed weights, relative to the likeliest combo, are rounded to this many steps
/// per combo (3 decimals)...
const WEIGHT_STEPS: f32 = 1000.0;
/// ...and dropped below this.
pub const MIN_WEIGHT: f32 = 0.005;
/// Hero's exact hand is kept at least at this relative weight (of the likeliest combo)
/// so its strategy can be reported.
pub const HERO_FLOOR: f32 = 0.01;
/// Bet sizes both players get on stage-1 streets the line covers (stage 2's defaults).
/// Each bet the line used is added for the player who made it.
pub const LINE_BETS: &str = "33%, 75%";
/// Raise sizes both players get on streets the line covers (none); raises the line used
/// are added for the raiser. A default 3x raise for both didn't fit: a wide single-raised-pot
/// turn spot's stage-1 game needed 1.4 GB compressed (over the 1 GB cap) with it,
/// 0.56 GB without.
pub const LINE_RAISES: Option<&str> = None;
/// Bet size on stage-1 streets after the line (the current street and later), no raises.
pub const LATER_BETS: &str = "75%";
/// Default `RARE_LINE_THRESHOLD`: a player whose line takes less than this share of
/// their starting range gets a blended range (see [`blend_rare_line`]).
pub const RARE_LINE_THRESHOLD: f64 = 0.05;
/// Smallest share of a blended range that comes from the narrowed range, so the range
/// still leans toward the hands that fit the line however rare it is.
pub const MIN_ALPHA: f64 = 0.3;
const STREETS: [&str; 3] = ["flop", "turn", "river"];

// ---------- request side ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineStreet {
    Preflop,
    Flop,
    Turn,
    River,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Check,
    Bet,
    Call,
    Raise,
    Fold,
    Allin,
}

/// One entry of the request's `line`. `amount_chips`: bet size for a bet, raise-to
/// total for the street for a raise, ignored otherwise.
#[derive(Debug, Clone, Deserialize)]
pub struct LineAction {
    pub street: LineStreet,
    pub player: PlayerSide,
    pub action: LineKind,
    #[serde(default)]
    pub amount_chips: Option<f64>,
}

/// What stage 1 must do at each point of the walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Act { player: usize, want: Want },
    Deal(Card),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Want {
    Check,
    Call,
    /// Street-level amount in chips.
    Bet(i32),
    /// Raise-to total for the street, in chips.
    Raise(i32),
    /// All-in (current-street actions only; stage-1 lines with an all-in are skipped).
    AllIn,
}

/// A validated stage-1 job, built cheaply in `config::prepare` (before queueing).
#[derive(Debug, Clone)]
pub struct LinePlan {
    pub tree_config: TreeConfig,
    pub card_config: CardConfig,
    pub steps: Vec<Step>,
    pub sizes: Vec<LineSize>,
    pub max_iterations: u32,
    /// Preflop aggressor's player index, when the request gave one (see [`line_sizes`]).
    pub aggressor: Option<usize>,
    /// Flop + turn (+ river) cards of the current street.
    pub board_mask: u64,
}

#[derive(Debug, Clone)]
pub enum LineStatus {
    /// No line in the request.
    None,
    /// A line was given but can't be used; the reason is shown to the user.
    Skip(String),
    Plan(Box<LinePlan>),
}

impl LineStatus {
    pub fn is_plan(&self) -> bool {
        matches!(self, LineStatus::Plan(_))
    }
}

/// Builds the stage-1 plan from the request's `line`, `flop_pot`, `flop_stack` and the
/// already-validated stage-2 configs. Pure and cheap.
pub fn plan(
    line: Option<&[Value]>,
    flop_pot: Option<f64>,
    flop_stack: Option<f64>,
    card: &CardConfig,
    tree: &TreeConfig,
    max_iterations: u32,
    aggressor: Option<usize>,
) -> LineStatus {
    match line {
        None | Some([]) => LineStatus::None,
        Some(raw) => match build_plan(raw, flop_pot, flop_stack, card, tree, max_iterations, aggressor) {
            Ok(p) => LineStatus::Plan(Box::new(p)),
            Err(reason) => LineStatus::Skip(reason),
        },
    }
}

fn chips(v: Option<f64>, what: &str) -> Result<i32, String> {
    match v {
        Some(x) if x.is_finite() && x.round() > 0.0 && x.round() < i32::MAX as f64 / 4.0 => Ok(x.round() as i32),
        Some(_) => Err(format!("the {what} isn't a positive amount")),
        None => Err(format!("the {what} wasn't given")),
    }
}

fn side(p: usize) -> &'static str {
    if p == 0 { "OOP" } else { "IP" }
}

fn trim_float(s: String) -> String {
    if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s }
}

/// Shortest `N%` (pot-relative) bet size that makes the crate bet exactly `amount`
/// into `pot` (it computes `round(pot * N / 100)`). Falls back to 6 decimals.
pub fn pct_size(amount: i32, pot: i32) -> String {
    let exact = amount as f64 / pot as f64 * 100.0;
    for d in 0..=6 {
        let s = trim_float(format!("{exact:.d$}"));
        let r: f64 = s.parse().unwrap_or(exact) / 100.0;
        if (pot as f64 * r).round() as i32 == amount {
            return format!("{s}%");
        }
    }
    format!("{}%", trim_float(format!("{exact:.6}")))
}

/// Shortest `Nx` (multiple of the previous bet) raise size that makes the crate raise
/// to exactly `to` over a bet of `prev` (it computes `round(prev * N)`).
pub fn raise_size(to: i32, prev: i32) -> String {
    let exact = to as f64 / prev as f64;
    for d in 0..=6 {
        let s = trim_float(format!("{exact:.d$}"));
        let r: f64 = s.parse().unwrap_or(exact);
        if r > 1.0 && (prev as f64 * r).round() as i32 == to {
            return format!("{s}x");
        }
    }
    format!("{}x", trim_float(format!("{exact:.6}")))
}

/// Stage-1 default `(bets, raises)` for player `p` on line street `s`: [`LINE_BETS`] and
/// [`LINE_RAISES`], except that an OOP preflop caller (`aggressor` = IP) has no default flop
/// bets, i.e. doesn't lead the flop into the raiser (a lead the line used is still added).
///
/// Measured on a wide BTN-vs-BB turn spot (K72r, flop check / 33% bet / call): with OOP
/// flop leads and no raises, the solve had the BB lead the flop as a stand-in for the
/// missing check-raise, so only 26-36% of its range check-called (real BB strategies
/// almost never lead there); without leads, 76%. It also cut stage 1 from ~22 s to ~5 s.
/// Giving the caller a 3x check-raise instead was more faithful (45% check-call) but took
/// ~14-20 s, wasn't converged at 1% (IP's range 212 vs 296 combos at 0.3%), and pushed a
/// river spot's stage 1 to 2.3 GB raw / 1.2 GB compressed, over the cap.
pub fn line_sizes(s: usize, p: usize, aggressor: Option<usize>) -> (&'static str, &'static str) {
    let no_lead = s == 0 && p == 0 && aggressor == Some(1);
    (if no_lead { "" } else { LINE_BETS }, LINE_RAISES.unwrap_or(""))
}

/// Stage-1 `[OOP, IP]` sizes for street `s`: on a line street, the defaults plus that
/// player's added sizes; after the line, one bet size and no raises.
fn street_sizes(
    s: usize,
    current: usize,
    aggressor: Option<usize>,
    bets: &[Vec<String>; 2],
    raises: &[Vec<String>; 2],
) -> Result<[BetSizeOptions; 2], String> {
    let one = |p: usize| {
        let (bet, raise) = if s < current {
            let join = |base: &str, extra: &[String]| {
                std::iter::once(base).chain(extra.iter().map(String::as_str)).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", ")
            };
            let (base_bets, base_raises) = line_sizes(s, p, aggressor);
            (join(base_bets, &bets[p]), join(base_raises, &raises[p]))
        } else {
            (LATER_BETS.to_string(), String::new())
        };
        BetSizeOptions::try_from((bet.as_str(), raise.as_str()))
            .map_err(|e| format!("the line's {} sizes couldn't be used ({e})", STREETS[s]))
    };
    Ok([one(0)?, one(1)?])
}

fn build_plan(
    raw: &[Value],
    flop_pot: Option<f64>,
    flop_stack: Option<f64>,
    card: &CardConfig,
    tree: &TreeConfig,
    max_iterations: u32,
    aggressor: Option<usize>,
) -> Result<LinePlan, String> {
    let current = match tree.initial_state {
        BoardState::Flop => return Err("the spot is on the flop, so there's no earlier street to replay".into()),
        BoardState::Turn => 1,
        BoardState::River => 2,
    };

    let mut entries = Vec::with_capacity(raw.len());
    for (i, v) in raw.iter().enumerate() {
        let e: LineAction = serde_json::from_value(v.clone())
            .map_err(|e| format!("line entry {} couldn't be read ({e})", i + 1))?;
        if e.street != LineStreet::Preflop {
            entries.push(e);
        }
    }
    if entries.is_empty() {
        return Err("only preflop action was described".into());
    }
    let street_of = |e: &LineAction| e.street as usize - 1; // flop = 0
    if entries.windows(2).any(|w| street_of(&w[0]) > street_of(&w[1])) {
        return Err("the line's streets are out of order".into());
    }
    if entries.iter().any(|e| street_of(e) >= current) {
        return Err(format!("the line includes action on the {} itself", STREETS[current]));
    }

    let flop_pot = chips(flop_pot, "pot at the flop")?;
    let flop_stack = chips(flop_stack, "stack at the flop")?;

    let deal = [card.turn, card.river];
    let mut steps = Vec::new();
    let mut sizes = Vec::new();
    let defaults = |s: usize, p: usize| {
        BetSizeOptions::try_from(line_sizes(s, p, aggressor)).expect("valid default sizes")
    };
    // Sizes added on top of the defaults: [street][player].
    let mut bets: [[Vec<String>; 2]; 3] = Default::default();
    let mut raises: [[Vec<String>; 2]; 3] = Default::default();
    let mut pot = flop_pot;
    let mut stack = flop_stack;

    for s in 0..current {
        let name = STREETS[s];
        let acts: Vec<&LineAction> = entries.iter().filter(|e| street_of(e) == s).collect();
        if acts.is_empty() {
            return Err(format!("the line has no {name} action"));
        }
        // Street-level chips put in by each player.
        let mut put = [0i32; 2];
        let mut to_act = 0usize;
        let mut closed = false;
        for a in acts {
            if closed {
                return Err(format!("the {name} action goes on after the street was over"));
            }
            let p = a.player.index();
            if p != to_act {
                return Err(format!("the {name} action is out of turn ({} acted when {} was due)", side(p), side(to_act)));
            }
            let facing = put[p ^ 1] > put[p];
            let want = match a.action {
                LineKind::Fold => return Err(format!("the line has a fold on the {name}")),
                LineKind::Allin => return Err(format!("the line goes all-in on the {name}")),
                LineKind::Check => {
                    if facing {
                        return Err(format!("the line has a check facing a bet on the {name}"));
                    }
                    closed = p == 1;
                    Want::Check
                }
                LineKind::Call => {
                    if !facing {
                        return Err(format!("the line has a call with no bet to call on the {name}"));
                    }
                    put[p] = put[p ^ 1];
                    closed = true;
                    Want::Call
                }
                LineKind::Bet | LineKind::Raise => {
                    let amount = chips(a.amount_chips, &format!("{name} {} size", if facing { "raise" } else { "bet" }))?;
                    if amount >= stack {
                        return Err(format!("the line goes all-in on the {name}"));
                    }
                    let (want, kind, size, is_default) = if facing {
                        // "bet" facing a bet is a raise; the amount is the raise-to total.
                        let prev = put[p ^ 1];
                        if amount <= prev {
                            return Err(format!("a {name} raise isn't bigger than the bet before it"));
                        }
                        let is_default = defaults(s, p).raise.iter().any(|b| match *b {
                            BetSize::PrevBetRelative(r) => (prev as f64 * r).round() as i32 == amount,
                            _ => false,
                        });
                        (Want::Raise(amount), "raise", raise_size(amount, prev), is_default)
                    } else {
                        // "raise" into a check is a bet.
                        let is_default = defaults(s, p).bet.iter().any(|b| match *b {
                            BetSize::PotRelative(r) => (pot as f64 * r).round() as i32 == amount,
                            _ => false,
                        });
                        (Want::Bet(amount), "bet", pct_size(amount, pot), is_default)
                    };
                    let list = if facing { &mut raises[s][p] } else { &mut bets[s][p] };
                    if !is_default && !list.contains(&size) {
                        list.push(size.clone());
                    }
                    sizes.push(LineSize {
                        street: name.into(),
                        player: a.player,
                        action: kind.into(),
                        requested: amount,
                        used: None,
                        size,
                        added: !is_default,
                    });
                    put[p] = amount;
                    want
                }
            };
            steps.push(Step::Act { player: p, want });
            to_act ^= 1;
        }
        if !closed {
            return Err(format!("the {name} action doesn't end with a call or a check behind"));
        }
        pot += 2 * put[0];
        stack -= put[0];
        steps.push(Step::Deal(deal[s]));
    }

    // The line must land on the spot's pot and stack (small rounding allowed).
    let tol = |x: i32| (x as f64 * 0.01).max(4.0);
    if ((pot - tree.starting_pot) as f64).abs() > tol(tree.starting_pot) {
        return Err(format!(
            "the line's bets don't add up to the pot ({flop_pot} at the flop plus the line is {pot} chips, the spot has {})",
            tree.starting_pot
        ));
    }
    if ((stack - tree.effective_stack) as f64).abs() > tol(tree.effective_stack) {
        return Err(format!(
            "the line's bets don't match the stack ({stack} chips left after the line, the spot has {})",
            tree.effective_stack
        ));
    }

    let tree_config = TreeConfig {
        initial_state: BoardState::Flop,
        starting_pot: flop_pot,
        effective_stack: flop_stack,
        flop_bet_sizes: street_sizes(0, current, aggressor, &bets[0], &raises[0])?,
        turn_bet_sizes: street_sizes(1, current, aggressor, &bets[1], &raises[1])?,
        river_bet_sizes: street_sizes(2, current, aggressor, &bets[2], &raises[2])?,
        // No donk bets on streets after the line: they only give the line's streets
        // continuation values, and leads there were ~30% of the tree.
        turn_donk_sizes: (current == 1).then(no_donks),
        river_donk_sizes: Some(no_donks()),
        // No merging, so each line size stays in the tree next to a close default.
        merging_threshold: 0.0,
        ..tree.clone()
    };
    let card_config = CardConfig { range: card.range, flop: card.flop, turn: NOT_DEALT, river: NOT_DEALT };

    let mut board_mask: u64 = card.flop.iter().fold(0, |m, &c| m | (1 << c));
    for &c in &deal[..current] {
        board_mask |= 1 << c;
    }

    Ok(LinePlan {
        tree_config,
        card_config,
        steps,
        sizes,
        max_iterations: max_iterations.clamp(1, STAGE1_MAX_ITERATIONS),
        aggressor,
        board_mask,
    })
}

/// Donk options with no sizes: OOP can only check into the previous street's aggressor.
pub fn no_donks() -> DonkSizeOptions {
    DonkSizeOptions { donk: Vec::new() }
}

// ---------- stage 1 ----------

pub struct Narrowed {
    pub ranges: [Range; 2],
    pub summary: Narrowing,
}

/// Solves the stage-1 game, walks the line and reads the narrowed ranges.
/// Errors are human-readable skip reasons.
pub fn narrow(
    plan: LinePlan,
    hero: Option<&HeroSpec>,
    max_memory_mb: u64,
    rare_line_threshold: f64,
    deadline: Instant,
) -> Result<Narrowed, String> {
    let start = Instant::now();
    let LinePlan { tree_config, card_config, steps, mut sizes, max_iterations, aggressor, board_mask } = plan;
    let initial = card_config.range;
    let flop_pot = tree_config.starting_pot;

    let solved = solve::build_and_solve(
        tree_config,
        card_config,
        STAGE1_TARGET_PCT,
        max_iterations,
        deadline,
        max_memory_mb,
    )
    .map_err(|e| match e.reason {
        Reason::TreeTooLarge => "the flop solve for this line needs more memory than allowed".to_string(),
        Reason::InvalidRange => "the ranges couldn't be used for a flop solve".to_string(),
        other => format!("the flop solve failed ({})", other.code()),
    })?;
    let target = flop_pot as f32 * STAGE1_TARGET_PCT as f32 / 100.0;
    if solved.timed_out && solved.exploitability > target * 3.0 {
        return Err("the flop solve ran out of time".into());
    }
    let mut game = solved.game;

    walk(&mut game, &steps, &mut sizes)?;

    let mut ranges = [Range::new(), Range::new()];
    let mut summaries = Vec::with_capacity(2);
    let mut hero_weight = None;
    let mut hero_floored = false;
    for p in 0..2 {
        let hands = game.private_cards(p);
        let prior: Vec<f32> = hands.iter().map(|&(c1, c2)| initial[p].get_weight_by_cards(c1, c2)).collect();
        let live: Vec<bool> = hands.iter().map(|&(c1, c2)| !overlaps(c1, c2, board_mask)).collect();
        let (weights, fit) = blend_rare_line(&prior, game.weights(p), &live, rare_line_threshold);
        let weights = weights.as_slice();
        tracing::info!(player = side(p), line_probability = fit.probability, blended = fit.blended, alpha = fit.alpha, "stage-1 line fit");
        // Stage 2 only needs relative weights, and lines the flop solve rarely takes
        // leave every combo far below `MIN_WEIGHT`. Scale so the likeliest live combo
        // is 1 before rounding; summaries scale back to absolute combos.
        let scale = hands
            .iter()
            .zip(weights)
            .filter(|&(&(c1, c2), _)| !overlaps(c1, c2, board_mask))
            .map(|(_, &w)| w)
            .fold(0.0f32, f32::max);
        let relative: Vec<f32> = weights.iter().map(|&w| if scale > 0.0 { w / scale } else { 0.0 }).collect();
        let mut r = weights_to_range(hands, &relative, board_mask);
        if live_sum(&r, board_mask) <= 0.0 {
            let who = match hero {
                Some(h) if h.player.index() == p => "your range",
                Some(_) => "villain's range",
                None => side(p),
            };
            return Err(format!("{who} never takes this line in the flop solve"));
        }
        if let Some(h) = hero.filter(|h| h.player.index() == p) {
            let (c1, c2) = h.cards;
            let w = r.get_weight_by_cards(c1, c2);
            hero_weight = Some(round((w * scale) as f64, 3));
            if w < HERO_FLOOR {
                r.set_weight_by_cards(c1, c2, HERO_FLOOR);
                hero_floored = true;
            }
        }
        fill_dead(&mut r, board_mask);
        summaries.push(NarrowedPlayer {
            summary: summarize(&initial[p], &r, scale, board_mask),
            line_probability: round(fit.probability, 5),
            blended: fit.blended,
            alpha: round(fit.alpha, 3),
        });
        ranges[p] = r;
    }
    let strings = [ranges[0].to_string(), ranges[1].to_string()];
    // Stage 2 solves exactly what is reported.
    for p in 0..2 {
        ranges[p] = strings[p].parse().map_err(|e| format!("the narrowed range didn't parse ({e})"))?;
    }
    let ip = summaries.pop().unwrap();
    let oop = summaries.pop().unwrap();

    Ok(Narrowed {
        ranges,
        summary: Narrowing {
            narrowed: true,
            reason: None,
            oop_range: Some(strings[0].clone()),
            ip_range: Some(strings[1].clone()),
            ranges: Some(NarrowedRanges { oop, ip }),
            sizes,
            line_bets: Some(LINE_BETS.into()),
            line_raises: LINE_RAISES.map(Into::into),
            line_aggressor: aggressor.map(PlayerSide::from_index),
            hero_weight,
            hero_floored,
            iterations: Some(solved.iterations),
            exploitability_pct: Some(round(solved.exploitability as f64 / flop_pot as f64 * 100.0, 4)),
            memory_mb: Some(round(solved.memory_bytes as f64 / (1024.0 * 1024.0), 1)),
            solve_ms: start.elapsed().as_millis() as u64,
            rare_line_threshold: Some(rare_line_threshold),
        },
    })
}

/// How well a player's range fits the stage-1 line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineFit {
    /// Σ reach / Σ prior over live combos: the share of the starting range that takes
    /// the line in the flop solve.
    pub probability: f64,
    pub blended: bool,
    /// Share of the result taken from the narrowed range (1 when not blended).
    pub alpha: f64,
}

/// Rare-line handling (SPEC §7 "Rare lines"). `prior` is the starting weight and `reach`
/// the absolute stage-1 reach (prior × the player's own action frequencies along the
/// line) of each combo, indexed alike; only `live` combos (not on the board) count.
///
/// With line probability `p` ≥ `threshold` the reach is returned unchanged. Below it
/// (a line the equilibrium almost never takes, whose narrowed range is a few combos
/// picked by fine solver detail), the result is
///
/// ```text
/// w_i = α·reach_i + (1 − α)·R·feasible_i / Σ feasible,   α = max(p / threshold, MIN_ALPHA)
/// feasible_i = min(prior_i, reach_i / p),                R = Σ reach
/// ```
///
/// i.e. α·normalized(narrowed) + (1 − α)·normalized(feasible), scaled back to the
/// narrowed range's total. `feasible` is the line-feasible part of the starting range:
/// each combo counts at its full starting weight if it takes the line at least as often
/// as the range as a whole (`reach_i / prior_i ≥ p`), proportionally less if rarer, and
/// not at all if it never does. It flattens the few combos the equilibrium concentrates
/// on into every hand that plausibly fits the line. α is continuous at the threshold
/// (1 there) and never below `MIN_ALPHA`. The total stays `R`, and every `w_i` stays at
/// or below `prior_i` (`R·feasible_i / Σ feasible ≤ feasible_i` as `Σ feasible ≥ R`).
/// A combo with no reach stays out.
pub fn blend_rare_line(prior: &[f32], reach: &[f32], live: &[bool], threshold: f64) -> (Vec<f32>, LineFit) {
    let live_sum = |v: &[f32]| v.iter().zip(live).filter(|&(_, &l)| l).map(|(&x, _)| x as f64).sum::<f64>();
    let (total_prior, total_reach) = (live_sum(prior), live_sum(reach));
    let probability = if total_prior > 0.0 { (total_reach / total_prior).clamp(0.0, 1.0) } else { 0.0 };
    if probability >= threshold || total_reach <= 0.0 {
        return (reach.to_vec(), LineFit { probability, blended: false, alpha: 1.0 });
    }
    let alpha = (probability / threshold).max(MIN_ALPHA);
    let feasible: Vec<f64> = prior
        .iter()
        .zip(reach)
        .zip(live)
        .map(|((&w0, &w), &l)| if l { (w0 as f64).min(w as f64 / probability) } else { 0.0 })
        .collect();
    let total_feasible: f64 = feasible.iter().sum();
    let out = reach
        .iter()
        .zip(&feasible)
        .map(|(&w, &f)| (alpha * w as f64 + (1.0 - alpha) * total_reach * f / total_feasible) as f32)
        .collect();
    (out, LineFit { probability, blended: true, alpha })
}

/// Plays the line on a solved game: each action (matched by kind, bets and raises by
/// closest amount) and each dealt card, ending at the first decision of the current
/// street. Fills `used` on `sizes` in order.
pub fn walk(game: &mut PostFlopGame, steps: &[Step], sizes: &mut [LineSize]) -> Result<(), String> {
    const MISMATCH: &str = "the line couldn't be matched in the flop solve's tree";
    game.back_to_root();
    let mut size_i = 0;
    for step in steps {
        if game.is_terminal_node() {
            return Err(MISMATCH.into());
        }
        match *step {
            Step::Deal(card) => {
                if !game.is_chance_node() || game.possible_cards() & (1u64 << card) == 0 {
                    return Err(MISMATCH.into());
                }
                game.play(card as usize);
            }
            Step::Act { player, want } => {
                if game.is_chance_node() || game.current_player() != player {
                    return Err(MISMATCH.into());
                }
                let actions = game.available_actions();
                let closest = |target: i32, bet: bool| {
                    actions
                        .iter()
                        .enumerate()
                        .filter_map(|(i, a)| match (*a, bet) {
                            (Action::Bet(x), true) | (Action::Raise(x), false) => Some((i, x)),
                            _ => None,
                        })
                        .min_by_key(|&(_, x)| (x - target).abs())
                };
                let idx = match want {
                    Want::Check => actions.iter().position(|a| *a == Action::Check),
                    Want::Call => actions.iter().position(|a| *a == Action::Call),
                    Want::AllIn => actions.iter().position(|a| matches!(a, Action::AllIn(_))),
                    Want::Bet(x) | Want::Raise(x) => {
                        let found = closest(x, matches!(want, Want::Bet(_)));
                        match found {
                            // Within 10% of the size: report it as rounding.
                            Some((i, used)) if (used - x).abs() as f64 <= (x as f64 * 0.1).max(1.0) => {
                                if let Some(s) = sizes.get_mut(size_i) {
                                    s.used = Some(used);
                                }
                                size_i += 1;
                                Some(i)
                            }
                            _ if actions.iter().any(|a| matches!(a, Action::AllIn(_))) => {
                                return Err("a bet in the line is so close to all-in that the solver treats it as all-in".into());
                            }
                            _ => None,
                        }
                    }
                };
                game.play(idx.ok_or(MISMATCH)?);
            }
        }
    }
    if game.is_terminal_node() || game.is_chance_node() {
        return Err(MISMATCH.into());
    }
    Ok(())
}

fn overlaps(c1: Card, c2: Card, mask: u64) -> bool {
    ((1u64 << c1) | (1u64 << c2)) & mask != 0
}

fn quantize(w: f32) -> f32 {
    let q = (w.clamp(0.0, 1.0) * WEIGHT_STEPS).round() / WEIGHT_STEPS;
    if q < MIN_WEIGHT { 0.0 } else { q }
}

/// Per-combo weights (indexed like `hands`) as a `Range`, rounded to 3 decimals, tiny
/// weights and board-blocked combos dropped.
pub fn weights_to_range(hands: &[(Card, Card)], weights: &[f32], board_mask: u64) -> Range {
    let mut r = Range::new();
    for (&(c1, c2), &w) in hands.iter().zip(weights) {
        if !overlaps(c1, c2, board_mask) {
            let q = quantize(w);
            if q > 0.0 {
                r.set_weight_by_cards(c1, c2, q);
            }
        }
    }
    r
}

/// Every hand class (pair / suited / offsuit) as its list of combos.
fn classes() -> Vec<Vec<(Card, Card)>> {
    let mut out = Vec::with_capacity(169);
    for hi in (0..13u8).rev() {
        for lo in (0..=hi).rev() {
            if hi == lo {
                let mut v = Vec::with_capacity(6);
                for s1 in 0..4 {
                    for s2 in s1 + 1..4 {
                        v.push((4 * hi + s1, 4 * hi + s2));
                    }
                }
                out.push(v);
            } else {
                out.push((0..4).map(|s| (4 * lo + s, 4 * hi + s)).collect());
                let mut off = Vec::with_capacity(12);
                for s1 in 0..4 {
                    for s2 in 0..4 {
                        if s1 != s2 {
                            off.push((4 * lo + s2, 4 * hi + s1));
                        }
                    }
                }
                out.push(off);
            }
        }
    }
    out
}

/// Board-blocked combos can't be dealt, so their weight doesn't matter. Giving them the
/// class's weight (when its live combos agree) lets `Range::to_string` write the class
/// as one token ("KQs:0.5") instead of one token per combo.
pub fn fill_dead(r: &mut Range, board_mask: u64) {
    for class in classes() {
        let (dead, live): (Vec<_>, Vec<_>) = class.into_iter().partition(|&(a, b)| overlaps(a, b, board_mask));
        if dead.is_empty() || live.is_empty() {
            continue;
        }
        let w = r.get_weight_by_cards(live[0].0, live[0].1);
        if w > 0.0 && live.iter().all(|&(a, b)| r.get_weight_by_cards(a, b) == w) {
            for (a, b) in dead {
                r.set_weight_by_cards(a, b, w);
            }
        }
    }
}

fn live_sum(r: &Range, board_mask: u64) -> f64 {
    classes()
        .into_iter()
        .flatten()
        .filter(|&(a, b)| !overlaps(a, b, board_mask))
        .map(|(a, b)| r.get_weight_by_cards(a, b) as f64)
        .sum()
}

/// Combo counts before/after and per-class weights, live combos only. `after` holds
/// relative weights; `scale` turns them back into absolute ones.
pub fn summarize(before: &Range, after: &Range, scale: f32, board_mask: u64) -> RangeSummary {
    let mut combos_before = 0.0;
    let mut combos_after = 0.0;
    let mut out = Vec::new();
    for class in classes() {
        let live: Vec<_> = class.into_iter().filter(|&(a, b)| !overlaps(a, b, board_mask)).collect();
        if live.is_empty() {
            continue;
        }
        let b: f64 = live.iter().map(|&(x, y)| before.get_weight_by_cards(x, y) as f64).sum();
        let rel: f64 = live.iter().map(|&(x, y)| after.get_weight_by_cards(x, y) as f64).sum();
        let a = rel * scale as f64;
        combos_before += b;
        combos_after += a;
        if rel >= MIN_WEIGHT as f64 {
            out.push(ClassWeight {
                hand: class_name(live[0]),
                combos: round(a, 3),
                weight: round(a / live.len() as f64, 4),
            });
        }
    }
    out.sort_by(|x, y| y.combos.total_cmp(&x.combos).then_with(|| x.hand.cmp(&y.hand)));
    RangeSummary { combos_before: round(combos_before, 1), combos_after: round(combos_after, 2), classes: out }
}

/// A skipped narrowing (the request is solved from its own ranges).
pub fn skipped(reason: String, solve_ms: u64) -> Narrowing {
    Narrowing {
        narrowed: false,
        reason: Some(reason),
        oop_range: None,
        ip_range: None,
        ranges: None,
        sizes: Vec::new(),
        line_bets: None,
        line_raises: None,
        line_aggressor: None,
        hero_weight: None,
        hero_floored: false,
        iterations: None,
        exploitability_pct: None,
        memory_mb: None,
        solve_ms,
        rare_line_threshold: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_board;
    use postflop_solver::card_from_str;
    use serde_json::json;
    use std::time::Duration;

    fn c(s: &str) -> Card {
        card_from_str(s).unwrap()
    }

    fn opts(bet: &str, raise: &str) -> BetSizeOptions {
        BetSizeOptions::try_from((bet, raise)).unwrap()
    }

    #[test]
    fn pct_sizes_reproduce_amounts() {
        assert_eq!(pct_size(275, 550), "50%");
        assert_eq!(pct_size(2500, 2450), "102.04%");
        assert_eq!(pct_size(100, 300), "33.3%");
        for (amount, pot) in [(2500, 2450), (1, 7), (12345, 999), (183, 550), (9999, 100_000)] {
            let s = pct_size(amount, pot);
            let opts = BetSizeOptions::try_from((s.as_str(), "")).unwrap();
            let postflop_solver::BetSize::PotRelative(r) = opts.bet[0] else { panic!("{s}") };
            assert_eq!((pot as f64 * r).round() as i32, amount, "{s}");
        }
    }

    #[test]
    fn raise_sizes_reproduce_amounts() {
        assert_eq!(raise_size(900, 300), "3x");
        assert_eq!(raise_size(750, 300), "2.5x");
        for (to, prev) in [(900, 300), (777, 250), (2501, 1000), (10, 3)] {
            let s = raise_size(to, prev);
            let opts = BetSizeOptions::try_from(("", s.as_str())).unwrap();
            let postflop_solver::BetSize::PrevBetRelative(r) = opts.raise[0] else { panic!("{s}") };
            assert_eq!((prev as f64 * r).round() as i32, to, "{s}");
        }
    }

    const OOP: &str = "QQ,JJ,AQs,KJs,87s";
    const IP: &str = "AA,KK,AKs,J8s,T9s";

    fn configs(board: &str, pot: i32, stack: i32) -> (CardConfig, TreeConfig) {
        let (flop, turn, river) = parse_board(board).unwrap();
        let card = CardConfig { range: [OOP.parse().unwrap(), IP.parse().unwrap()], flop, turn, river };
        let o = BetSizeOptions::try_from(("33%, 75%", "3x")).unwrap();
        let tree = TreeConfig {
            initial_state: crate::config::board_state(turn, river),
            starting_pot: pot,
            effective_stack: stack,
            flop_bet_sizes: [o.clone(), o.clone()],
            turn_bet_sizes: [o.clone(), o.clone()],
            river_bet_sizes: [o.clone(), o],
            add_allin_threshold: 1.5,
            force_allin_threshold: 0.15,
            merging_threshold: 0.1,
            ..TreeConfig::default()
        };
        (card, tree)
    }

    fn a(street: &str, player: &str, action: &str, amount: Option<i32>) -> Value {
        json!({"street": street, "player": player, "action": action, "amount_chips": amount})
    }

    /// Flop: OOP checks, IP bets 400 into 550, OOP calls -> turn pot 1350, stack 9350.
    fn flop_line() -> Vec<Value> {
        vec![a("flop", "oop", "check", None), a("flop", "ip", "bet", Some(400)), a("flop", "oop", "call", None)]
    }

    fn plan_for(line: &[Value], board: &str, pot: i32, stack: i32) -> LineStatus {
        let (card, tree) = configs(board, pot, stack);
        plan(Some(line), Some(550.0), Some(9750.0), &card, &tree, 1000, None)
    }

    fn skip_reason(s: LineStatus) -> String {
        match s {
            LineStatus::Skip(r) => r,
            other => panic!("expected skip, got {other:?}"),
        }
    }

    #[test]
    fn plans_a_turn_spot() {
        let LineStatus::Plan(p) = plan_for(&flop_line(), "Td9d6hQc", 1350, 9350) else { panic!() };
        assert_eq!(p.tree_config.initial_state, BoardState::Flop);
        assert_eq!((p.tree_config.starting_pot, p.tree_config.effective_stack), (550, 9750));
        assert_eq!(p.sizes.len(), 1);
        assert_eq!(p.sizes[0].size, "72.7%");
        assert!(p.sizes[0].added);
        // Line street: defaults for both, IP's bet added for IP only.
        assert_eq!(p.tree_config.flop_bet_sizes[0], opts("33%, 75%", ""));
        assert_eq!(p.tree_config.flop_bet_sizes[1], opts("33%, 75%, 72.7%", ""));
        // After the line: one size, no raises.
        for s in [&p.tree_config.turn_bet_sizes, &p.tree_config.river_bet_sizes] {
            assert_eq!(s, &[opts("75%", ""), opts("75%", "")]);
        }
        assert_eq!(p.tree_config.merging_threshold, 0.0);
        assert_eq!(
            p.steps,
            vec![
                Step::Act { player: 0, want: Want::Check },
                Step::Act { player: 1, want: Want::Bet(400) },
                Step::Act { player: 0, want: Want::Call },
                Step::Deal(c("Qc")),
            ]
        );
        assert_eq!(p.card_config.turn, NOT_DEALT);
    }

    #[test]
    fn ip_raiser_means_no_oop_flop_leads_and_no_later_donks() {
        let (card, tree) = configs("Td9d6hQc", 1350, 9350);
        let LineStatus::Plan(p) = plan(Some(&flop_line()), Some(550.0), Some(9750.0), &card, &tree, 60, Some(1)) else {
            panic!()
        };
        assert_eq!(p.tree_config.flop_bet_sizes[0], opts("", ""));
        assert_eq!(p.tree_config.flop_bet_sizes[1], opts("33%, 75%, 72.7%", ""));
        // Streets after the line (turn, river): no donk bets.
        let none = Some(DonkSizeOptions { donk: vec![] });
        assert_eq!((p.tree_config.turn_donk_sizes.clone(), p.tree_config.river_donk_sizes.clone()), (none.clone(), none.clone()));

        // An OOP lead the line used is added for OOP even at a default size (33% = 182).
        let lead = vec![a("flop", "oop", "bet", Some(182)), a("flop", "ip", "call", None)];
        let (card, tree) = configs("Td9d6hQc", 914, 9568);
        let LineStatus::Plan(p) = plan(Some(&lead), Some(550.0), Some(9750.0), &card, &tree, 60, Some(1)) else {
            panic!()
        };
        assert_eq!(p.tree_config.flop_bet_sizes[0], opts("33%", ""));
        assert!(p.sizes[0].added);

        // OOP raised preflop (or no raiser given): both players get the defaults.
        for agg in [Some(0), None] {
            let LineStatus::Plan(p) = plan(Some(&lead), Some(550.0), Some(9750.0), &card, &tree, 60, agg) else {
                panic!()
            };
            assert_eq!(p.tree_config.flop_bet_sizes[0], opts("33%, 75%", ""), "{agg:?}");
            assert!(!p.sizes[0].added);
        }

        // River spot: the turn is a line street (donks as usual), the river isn't.
        let mut river_line = flop_line();
        river_line.extend([a("turn", "oop", "check", None), a("turn", "ip", "check", None)]);
        let (card, tree) = configs("Td9d6hQc2s", 1350, 9350);
        let LineStatus::Plan(p) = plan(Some(&river_line), Some(550.0), Some(9750.0), &card, &tree, 60, Some(1)) else {
            panic!()
        };
        assert_eq!((p.tree_config.turn_donk_sizes.clone(), p.tree_config.river_donk_sizes.clone()), (None, none));
        assert_eq!(p.tree_config.turn_bet_sizes[0], opts("33%, 75%", ""));
    }

    #[test]
    fn fallbacks_have_reasons() {
        let turn = ("Td9d6hQc", 1350, 9350);
        let cases: Vec<(Vec<Value>, &str, i32, i32, &str)> = vec![
            (vec![a("flop", "oop", "check", None), a("flop", "ip", "bet", Some(400)), a("flop", "oop", "fold", None)], turn.0, turn.1, turn.2, "fold"),
            (vec![a("flop", "oop", "allin", None)], turn.0, turn.1, turn.2, "all-in"),
            (vec![a("flop", "oop", "bet", Some(9750)), a("flop", "ip", "call", None)], turn.0, turn.1, turn.2, "all-in"),
            (vec![a("preflop", "ip", "raise", Some(250))], turn.0, turn.1, turn.2, "only preflop"),
            (vec![a("flop", "oop", "check", None), a("flop", "ip", "bet", Some(400))], turn.0, turn.1, turn.2, "doesn't end"),
            (vec![a("flop", "ip", "check", None)], turn.0, turn.1, turn.2, "out of turn"),
            (flop_line(), turn.0, 2000, turn.2, "don't add up"),
            (flop_line(), "Td9d6hQc2s", 1350, 9350, "no turn action"),
            (flop_line(), "Td9d6h", 550, 9750, "on the flop"),
            (vec![a("turn", "oop", "check", None)], turn.0, turn.1, turn.2, "on the turn itself"),
            (vec![json!({"street": "flop", "player": "hero", "action": "check"})], turn.0, turn.1, turn.2, "couldn't be read"),
        ];
        for (line, board, pot, stack, want) in cases {
            let reason = skip_reason(plan_for(&line, board, pot, stack));
            assert!(reason.contains(want), "{want:?} not in {reason:?}");
        }
        let (card, tree) = configs("Td9d6hQc", 1350, 9350);
        let no_pot = plan(Some(&flop_line()), None, Some(9750.0), &card, &tree, 1000, None);
        assert!(skip_reason(no_pot).contains("wasn't given"));
        assert!(matches!(plan(None, None, None, &card, &tree, 1000, None), LineStatus::None));
        assert!(matches!(plan(Some(&[]), None, None, &card, &tree, 1000, None), LineStatus::None));
    }

    #[test]
    fn raise_into_check_is_a_bet_and_bet_facing_bet_is_a_raise() {
        let line = vec![
            a("flop", "oop", "check", None),
            a("flop", "ip", "raise", Some(400)),
            a("flop", "oop", "bet", Some(1200)),
            a("flop", "ip", "call", None),
        ];
        let LineStatus::Plan(p) = plan_for(&line, "Td9d6hQc", 550 + 2400, 9750 - 1200) else { panic!() };
        assert_eq!(p.sizes[0].action, "bet");
        assert_eq!(p.sizes[1].action, "raise");
        assert_eq!(p.sizes[1].size, "3x");
        // Each size goes to the player who used it.
        assert_eq!(p.tree_config.flop_bet_sizes[0], opts("33%, 75%", "3x"));
        assert_eq!(p.tree_config.flop_bet_sizes[1], opts("33%, 75%, 72.7%", ""));
    }

    #[test]
    fn default_sized_bets_are_not_duplicated_and_checked_streets_get_defaults() {
        // IP bets 413 = 75% of 550 on the flop; the turn checks through (river spot).
        let line = vec![
            a("flop", "oop", "check", None),
            a("flop", "ip", "bet", Some(413)),
            a("flop", "oop", "call", None),
            a("turn", "oop", "check", None),
            a("turn", "ip", "check", None),
        ];
        let LineStatus::Plan(p) = plan_for(&line, "Td9d6hQc2s", 550 + 826, 9750 - 413) else { panic!() };
        assert_eq!(p.sizes[0].size, "75%");
        assert!(!p.sizes[0].added);
        let d = opts("33%, 75%", "");
        assert_eq!(p.tree_config.flop_bet_sizes, [d.clone(), d.clone()]);
        assert_eq!(p.tree_config.turn_bet_sizes, [d.clone(), d]);
        assert_eq!(p.tree_config.river_bet_sizes, [opts("75%", ""), opts("75%", "")]);
    }

    #[test]
    fn weighted_ranges_round_trip_through_the_parser() {
        let board = parse_board("Qh2c7h8h").unwrap();
        let mask = board.0.iter().fold(1u64 << board.1, |m, &c| m | (1 << c));
        let full: Range = "TT+,A9s+,KTs+,QTs+,JTs,A5s-A2s,AJo+,KQo".parse().unwrap();
        let (hands, base) = full.get_hands_weights(mask);
        // Uneven, suit-dependent weights, some tiny (dropped), some exactly 1.
        let weights: Vec<f32> = hands
            .iter()
            .zip(&base)
            .enumerate()
            .map(|(i, (&(c1, _), &w))| match i % 4 {
                0 => w,
                1 => 0.123_456,
                2 => 0.001,
                _ => if c1 % 4 == 2 { 0.5 } else { 0.25 },
            })
            .collect();
        let mut r = weights_to_range(&hands, &weights, mask);
        fill_dead(&mut r, mask);
        let s = r.to_string();
        let back: Range = s.parse().unwrap();
        for (&(c1, c2), &w) in hands.iter().zip(&weights) {
            let want = quantize(w);
            assert_eq!(back.get_weight_by_cards(c1, c2), want, "{c1} {c2} in {s}");
        }
        assert!(!s.contains("0.001"), "{s}");
        assert!(s.contains("0.123"), "{s}");

        // Uniform classes collapse to class tokens even with board-blocked combos.
        let mut u = Range::new();
        let (h2, _) = full.get_hands_weights(mask);
        for &(c1, c2) in &h2 {
            u.set_weight_by_cards(c1, c2, 0.5);
        }
        fill_dead(&mut u, mask);
        let su = u.to_string();
        assert!(su.contains("TT+:0.5"), "{su}");
        assert!(su.len() < 120, "{su}");
    }

    #[test]
    fn walks_a_small_tree_and_narrows() {
        let (card, tree) = configs("Td9d6hQc", 1350, 9350);
        // IP raised preflop: OOP doesn't lead the flop (with leads and these tiny ranges,
        // OOP leads so often that the check-call line rounds to nothing).
        let LineStatus::Plan(p) = plan(Some(&flop_line()), Some(550.0), Some(9750.0), &card, &tree, 60, Some(1)) else {
            panic!()
        };
        let initial = p.card_config.range;
        let hero = HeroSpec { player: PlayerSide::Ip, cards: (c("Kh").min(c("Ah")), c("Kh").max(c("Ah"))) };
        let n = narrow(*p, Some(&hero), 4096, 0.0, Instant::now() + Duration::from_secs(120)).unwrap();
        let s = &n.summary;
        assert!(s.narrowed);
        assert_eq!(s.sizes[0].used, Some(400));
        let r = s.ranges.as_ref().unwrap();
        // OOP called a bet: its range can only shrink; IP's bet range too.
        assert!(r.oop.summary.combos_after <= r.oop.summary.combos_before + 1e-6, "{r:?}");
        assert!(r.ip.summary.combos_after <= r.ip.summary.combos_before + 1e-6, "{r:?}");
        assert!(r.oop.summary.combos_after > 0.0 && r.ip.summary.combos_after > 0.0);
        // Threshold 0: never blended; the line probability is still reported.
        for pl in [&r.oop, &r.ip] {
            assert!(!pl.blended && pl.alpha == 1.0, "{pl:?}");
            assert!(pl.line_probability > 0.0 && pl.line_probability <= 1.0);
        }
        assert!(s.hero_weight.is_some());
        // Strings round-trip and weights never exceed the starting range.
        for (p, text) in [(0, s.oop_range.as_ref().unwrap()), (1, s.ip_range.as_ref().unwrap())] {
            let back: Range = text.parse().unwrap();
            assert_eq!(back.raw_data(), n.ranges[p].raw_data());
            for (i, &w) in back.raw_data().iter().enumerate() {
                assert!(w <= initial[p].raw_data()[i] + 1e-6 || w == HERO_FLOOR);
            }
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn line_probability_counts_live_combos_only() {
        let prior = [1.0, 1.0, 0.5, 0.5, 1.0];
        let reach = [0.5, 0.25, 0.25, 0.0, 0.9];
        // The last combo is on the board: ignored on both sides.
        let live = [true, true, true, true, false];
        let (out, fit) = blend_rare_line(&prior, &reach, &live, 0.05);
        assert!(close(fit.probability, 1.0 / 3.0), "{fit:?}");
        // Common line: the narrowed range is used as is.
        assert_eq!(fit, LineFit { probability: fit.probability, blended: false, alpha: 1.0 });
        assert_eq!(out, reach.to_vec());
        // No live prior at all.
        let (_, fit) = blend_rare_line(&[1.0], &[0.0], &[false], 0.05);
        assert_eq!(fit.probability, 0.0);
    }

    #[test]
    fn threshold_decides_blending_and_alpha_is_continuous() {
        let prior = [1.0f32; 10];
        let live = [true; 10];
        // p = 0.05 exactly: not blended.
        let mut reach = [0.0f32; 10];
        reach[0] = 0.5;
        let (_, fit) = blend_rare_line(&prior, &reach, &live, 0.05);
        assert!(close(fit.probability, 0.05) && !fit.blended, "{fit:?}");
        // Just under: blended with alpha close to 1.
        reach[0] = 0.49;
        let (out, fit) = blend_rare_line(&prior, &reach, &live, 0.05);
        assert!(fit.blended && fit.alpha > 0.97, "{fit:?}");
        assert!((out[0] - 0.49).abs() < 0.02, "{out:?}");
        // Very rare: alpha floored.
        reach[0] = 0.001;
        let (_, fit) = blend_rare_line(&prior, &reach, &live, 0.05);
        assert_eq!(fit.alpha, MIN_ALPHA);
        // Threshold 0 turns blending off.
        let (out, fit) = blend_rare_line(&prior, &reach, &live, 0.0);
        assert!(!fit.blended && out == reach.to_vec());
        // No reach at all: nothing to blend (stage 1 reports "never takes this line").
        let (out, fit) = blend_rare_line(&prior, &[0.0; 10], &live, 0.05);
        assert!(!fit.blended && out.iter().all(|&w| w == 0.0));
    }

    #[test]
    fn blend_formula() {
        let prior = [1.0f32, 1.0, 1.0, 0.5, 1.0];
        let reach = [0.04f32, 0.001, 0.0005, 0.0, 0.0];
        let live = [true; 5];
        let (out, fit) = blend_rare_line(&prior, &reach, &live, 0.05);
        let r: f64 = reach.iter().map(|&x| x as f64).sum();
        let p = r / 4.5;
        assert!(close(fit.probability, p) && fit.blended);
        // alpha = max(p / 0.05, 0.3) = 0.3 here (p ≈ 0.0092).
        assert_eq!(fit.alpha, MIN_ALPHA);
        // feasible = min(prior, reach / p).
        let feasible: Vec<f64> = prior.iter().zip(&reach).map(|(&w0, &w)| (w0 as f64).min(w as f64 / p)).collect();
        assert!(close(feasible[0], 1.0) && feasible[1] < 1.0 && feasible[3] == 0.0);
        let fsum: f64 = feasible.iter().sum();
        for i in 0..5 {
            let want = 0.3 * reach[i] as f64 + 0.7 * r * feasible[i] / fsum;
            assert!(close(out[i] as f64, want), "{i}: {} vs {want}", out[i]);
            // Never above the starting weight; no reach stays out.
            assert!(out[i] <= prior[i]);
        }
        assert_eq!((out[3], out[4]), (0.0, 0.0));
        // The total is the narrowed range's, so absolute combo counts stay comparable.
        assert!(close(out.iter().map(|&x| x as f64).sum(), r));
        // The concentrated combo gives up share to the other line-feasible ones.
        assert!(out[0] / out[1] < reach[0] / reach[1]);
        assert!(out[0] > out[1] && out[1] > out[2]);
    }

    #[test]
    fn blended_narrowing_keeps_heros_hand_and_reports_the_fit() {
        let (card, tree) = configs("Td9d6hQc", 1350, 9350);
        let LineStatus::Plan(p) = plan(Some(&flop_line()), Some(550.0), Some(9750.0), &card, &tree, 20, None) else {
            panic!()
        };
        // Threshold 1: every player whose whole range doesn't take the line is blended.
        let hero = HeroSpec { player: PlayerSide::Ip, cards: (c("Ks").min(c("As")), c("Ks").max(c("As"))) };
        let n = narrow(*p, Some(&hero), 4096, 1.0, Instant::now() + Duration::from_secs(120)).unwrap();
        let s = &n.summary;
        assert!(s.narrowed);
        assert_eq!(s.rare_line_threshold, Some(1.0));
        let r = s.ranges.as_ref().unwrap();
        for pl in [&r.oop, &r.ip] {
            assert!(pl.blended, "{pl:?}");
            assert!(pl.line_probability > 0.0 && pl.line_probability < 1.0);
            assert!((MIN_ALPHA..=1.0).contains(&pl.alpha));
            assert!((pl.alpha - pl.line_probability.max(MIN_ALPHA)).abs() < 1e-3, "{pl:?}");
            // combos_after = p × combos_before (up to rounding of tiny weights).
            let want = pl.line_probability * pl.summary.combos_before;
            assert!((pl.summary.combos_after - want).abs() <= want * 0.05 + 0.05, "{pl:?}");
        }
        // Hero's exact hand stays in hero's range.
        assert!(n.ranges[1].get_weight_by_cards(hero.cards.0, hero.cards.1) >= HERO_FLOOR);
    }

    #[test]
    fn walk_rejects_lines_not_in_the_tree() {
        let (card, tree) = configs("Td9d6hQc", 1350, 9350);
        let LineStatus::Plan(p) = plan(Some(&flop_line()), Some(550.0), Some(9750.0), &card, &tree, 5, None) else {
            panic!()
        };
        let solved = solve::build_and_solve(
            p.tree_config.clone(),
            p.card_config.clone(),
            STAGE1_TARGET_PCT,
            5,
            Instant::now() + Duration::from_secs(60),
            4096,
        )
        .unwrap();
        let mut game = solved.game;
        // OOP has only the defaults (182 = 33%, 413 = 75%); IP also has the line's 400,
        // kept next to 413 because stage 1 doesn't merge close sizes.
        game.back_to_root();
        assert_eq!(game.available_actions(), vec![Action::Check, Action::Bet(182), Action::Bet(413)]);
        game.play(0);
        assert_eq!(game.available_actions(), vec![Action::Check, Action::Bet(182), Action::Bet(400), Action::Bet(413)]);
        let mut sizes = p.sizes.clone();
        // IP acting first on the flop isn't possible.
        let bad = [Step::Act { player: 1, want: Want::Check }];
        assert!(walk(&mut game, &bad, &mut sizes).is_err());
        // A bet size far from anything in the tree.
        let bad = [Step::Act { player: 0, want: Want::Check }, Step::Act { player: 1, want: Want::Bet(5000) }];
        assert!(walk(&mut game, &bad, &mut sizes).is_err());
        // The real line works and takes the exact line size, not the nearby 75%.
        assert!(walk(&mut game, &p.steps, &mut sizes).is_ok());
        assert_eq!(sizes[0].used, Some(400));
        assert_eq!(game.current_board().len(), 4);
    }
}
