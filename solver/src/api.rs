//! Request/response types for `POST /solve` (SPEC §7).

use serde::{Deserialize, Serialize};

// ---------- request ----------

#[derive(Debug, Clone, Deserialize)]
pub struct SolveRequest {
    /// 3-5 cards, e.g. "Td9d6hQc2s". Whitespace between cards is allowed.
    pub board: String,
    pub oop_range: String,
    pub ip_range: String,
    /// Chips (1bb = 100). Accepted as a JSON number and rounded to an integer.
    pub starting_pot: f64,
    pub effective_stack: f64,
    pub bet_sizes: StreetBetSizes,
    #[serde(default)]
    pub hero: Option<Hero>,
    /// Capped by the `MAX_ITERATIONS` env var. Defaults to that cap when omitted.
    #[serde(default)]
    pub max_iterations: Option<u32>,
    /// Percent of `starting_pot`. Defaults to 0.5 when omitted.
    #[serde(default)]
    pub target_exploitability_pct: Option<f64>,
    /// Earlier-street betting for a turn/river spot (see `line::LineAction`). When set,
    /// both ranges are first narrowed by a simplified flop solve of this line. Kept as
    /// raw JSON so a bad entry skips narrowing instead of rejecting the request.
    #[serde(default)]
    pub line: Option<Vec<serde_json::Value>>,
    /// Pot at the start of the flop, chips. Needed with `line`.
    #[serde(default)]
    pub flop_pot: Option<f64>,
    /// Effective stack at the start of the flop, chips. Needed with `line`.
    #[serde(default)]
    pub flop_stack: Option<f64>,
    /// Action on the current street before hero's decision (same entry shape as `line`,
    /// all on the current street). The solve adds the sizes to the actor's options,
    /// walks to hero's decision and reports that node (see `street.rs`). Kept as raw
    /// JSON so a bad entry falls back to the start of the street instead of failing.
    #[serde(default)]
    pub street_actions: Option<Vec<serde_json::Value>>,
    /// Villain's known hole cards: exact ("7c2d") or a hand class ("72o", "72s", "77",
    /// "72"). Villain's range becomes exactly those combos and villain's `street_actions`
    /// are locked. Needs `hero`.
    #[serde(default)]
    pub villain_hand: Option<String>,
    /// The preflop raiser (last aggressor). In stage 1 an OOP caller then doesn't lead the
    /// flop (`line::line_sizes`).
    #[serde(default)]
    pub preflop_aggressor: Option<PlayerSide>,
    /// Simpler trees to fall back to, in order, when `bet_sizes` is estimated over the
    /// solve-time budget (`TREE_BUDGET_SECS`) or memory. Auto-simplified trees (raises
    /// dropped, then one bet size per street) follow them. See `solve::pick_tree`.
    #[serde(default)]
    pub bet_size_fallbacks: Option<Vec<StreetBetSizes>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreetBetSizes {
    pub flop: BetSizePair,
    pub turn: BetSizePair,
    pub river: BetSizePair,
}

/// One street's sizes. `bet` / `raise` apply to both players unless `oop` / `ip` override
/// them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BetSizePair {
    pub bet: String,
    pub raise: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oop: Option<PlayerSizes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip: Option<PlayerSizes>,
    /// Turn/river only: OOP's lead sizes when OOP called the previous street's bet ("" =
    /// no leads, OOP checks to the aggressor). Absent: OOP's normal bet sizes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub donk: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PlayerSizes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raise: Option<String>,
}

impl BetSizePair {
    /// `(bet, raise)` strings for player `p` (0 = OOP).
    pub fn for_player(&self, p: usize) -> (&str, &str) {
        let o = if p == 0 { self.oop.as_ref() } else { self.ip.as_ref() };
        (
            o.and_then(|o| o.bet.as_deref()).unwrap_or(&self.bet),
            o.and_then(|o| o.raise.as_deref()).unwrap_or(&self.raise),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerSide {
    Oop,
    Ip,
}

impl PlayerSide {
    /// Player index used by `postflop-solver` (0 = OOP, 1 = IP).
    pub fn index(self) -> usize {
        match self {
            PlayerSide::Oop => 0,
            PlayerSide::Ip => 1,
        }
    }

    pub fn from_index(i: usize) -> Self {
        if i == 0 { PlayerSide::Oop } else { PlayerSide::Ip }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Hero {
    pub player: PlayerSide,
    #[serde(default)]
    pub hand: Option<String>,
}

// ---------- success response ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolveResponse {
    /// Always "ok".
    pub status: String,
    /// Percent of starting pot.
    pub exploitability_pct: f64,
    pub iterations: u32,
    pub solve_ms: u64,
    pub memory_mb: f64,
    pub compressed: bool,
    pub players: Players,
    pub nodes: Vec<NodeSummary>,
    pub hero_hand: Option<HeroHandSummary>,
    /// Present when the request had a `line`: whether the ranges were narrowed, and how.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrowing: Option<Narrowing>,
    /// Present when the request had `street_actions`: whether the walk to hero's decision
    /// worked (then `nodes` / `hero_hand` / `players` are at that decision), and how.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub street_line: Option<StreetLine>,
    /// Which tree was solved (SPEC §7 "Tree budget").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree: Option<TreeChoice>,
}

/// The tree stage 2 solved, picked from `[bet_sizes, ...bet_size_fallbacks, ...auto]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeChoice {
    /// Index into that list. `0` = the request's `bet_sizes`.
    pub index: usize,
    /// Trees the request gave (1 + fallbacks). `index >= given` = auto-simplified.
    pub given: usize,
    /// For auto-simplified trees: `"no_raises"` or `"one_size"` (raises dropped too).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<String>,
    /// Sizes of the solved tree (current-street sizes from `street_actions` come on top).
    pub bet_sizes: StreetBetSizes,
    /// Rough solve-time estimate from the tree's storage size, seconds.
    pub estimated_secs: f64,
    /// Raw (uncompressed) storage size, MB.
    pub raw_mb: f64,
    /// Every listed tree was estimated over `TREE_BUDGET_SECS`; this is the cheapest one.
    pub over_budget: bool,
}

/// Result of walking `street_actions` (SPEC §7 "street_actions").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreetLine {
    /// True: `nodes` end at hero's decision after the street actions. False: the
    /// usual start-of-street nodes, and `reason` says why.
    pub matched: bool,
    pub reason: Option<String>,
    /// Bets, raises and all-ins of the street actions and the size they were mapped to.
    pub sizes: Vec<LineSize>,
    /// Villain's whole range was forced to take the street actions: villain's hand is
    /// known, or the solver's villain (almost) never takes them (`villain_rare`).
    pub villain_locked: bool,
    /// The first solve's villain took the street actions with under
    /// `street::MIN_LINE_COMBOS` combos, so it was re-solved with villain locked.
    pub villain_rare: bool,
    /// Villain's range at hero's decision (`combos_before` = at the start of the street).
    pub villain_range: Option<RangeSummary>,
}

/// Stage-1 result (SPEC §7 "line"). `solve_ms` of the response covers both stages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Narrowing {
    pub narrowed: bool,
    /// Why the ranges weren't narrowed (when `narrowed` is false).
    pub reason: Option<String>,
    /// Weighted range strings the current street was solved with (crate syntax).
    pub oop_range: Option<String>,
    pub ip_range: Option<String>,
    pub ranges: Option<NarrowedRanges>,
    /// Bets and raises of the line and the size they were mapped to.
    pub sizes: Vec<LineSize>,
    /// Bet / raise sizes both players had on the line's streets in stage 1 (each
    /// `added` line size comes on top, for its player only).
    pub line_bets: Option<String>,
    pub line_raises: Option<String>,
    /// Preflop aggressor the stage-1 sizes were built around (request `preflop_aggressor`).
    /// When it's IP, OOP had no default flop bets (no leads into the raiser).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_aggressor: Option<PlayerSide>,
    /// Hero's exact hand's narrowed weight in [0, 1].
    pub hero_weight: Option<f64>,
    /// Hero's hand was below `HERO_FLOOR` and kept at that weight.
    pub hero_floored: bool,
    pub iterations: Option<u32>,
    /// Percent of the flop pot.
    pub exploitability_pct: Option<f64>,
    pub memory_mb: Option<f64>,
    /// Stage-1 wall time (build, solve, walk).
    pub solve_ms: u64,
    /// Line probability below which a player's narrowed range is blended toward its
    /// starting range (`RARE_LINE_THRESHOLD`; 0 = never). Set when narrowed.
    #[serde(default)]
    pub rare_line_threshold: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NarrowedRanges {
    pub oop: NarrowedPlayer,
    pub ip: NarrowedPlayer,
}

/// One player's narrowed range (SPEC §7 "Rare lines").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NarrowedPlayer {
    #[serde(flatten)]
    pub summary: RangeSummary,
    /// Share of the player's starting range (live combos, weighted) that takes the line
    /// in the flop solve, in [0, 1].
    pub line_probability: f64,
    /// The line was rarer than `rare_line_threshold`, so the range is a blend of the
    /// narrowed range and the line-feasible part of the starting range.
    pub blended: bool,
    /// Share of the blend taken from the narrowed range (1 when not blended).
    pub alpha: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RangeSummary {
    /// Sum of combo weights on the current board, before / after narrowing.
    pub combos_before: f64,
    pub combos_after: f64,
    /// Every class still in the range, most combos first.
    pub classes: Vec<ClassWeight>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassWeight {
    pub hand: String,
    /// Weighted combos left on the current board.
    pub combos: f64,
    /// Average weight of the class's live combos, in [0, 1].
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineSize {
    pub street: String,
    pub player: PlayerSide,
    /// "bet" | "raise" | "allin"
    pub action: String,
    /// Chips asked for (bet size, or raise-to total for the street; the all-in total for "allin").
    pub requested: i32,
    /// Chips the tree actually bet (null if the walk didn't get there).
    pub used: Option<i32>,
    /// Size string given to the solver, e.g. "102.04%" or "3x".
    pub size: String,
    /// True if the size was added to the acting player's stage-1 options (false when
    /// it equals a default size).
    pub added: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Players {
    pub oop: PlayerStats,
    pub ip: PlayerStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerStats {
    /// Range-average equity in [0, 1].
    pub equity: f64,
    /// Range-average EV in chips.
    pub ev: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSummary {
    pub line: Vec<String>,
    pub player: PlayerSide,
    pub actions: Vec<ActionSummary>,
    /// Chips in the middle at this node, bets on the current street included.
    #[serde(default)]
    pub pot: i32,
    /// Chips the acting player must add to call (0 when not facing a bet).
    #[serde(default)]
    pub to_call: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionSummary {
    /// "Fold" | "Check" | "Call" | "Bet" | "Raise" | "AllIn"
    pub action: String,
    /// Chips; 0 for Fold/Check/Call.
    pub amount: i32,
    pub frequency: f64,
    /// Hand-class names ("KK", "KQs", "A5o") of `top_classes`, same order. Kept as a
    /// plain string list for older clients.
    pub top_hands: Vec<String>,
    /// Up to 6 hand classes that put the most range weight into this action, largest first.
    pub top_classes: Vec<HandClass>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HandClass {
    /// "KK" (pair), "KQs" (suited) or "KQo" (offsuit).
    pub hand: String,
    /// How often this class takes the action: weighted average over its live combos, in [0, 1].
    pub frequency: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeroHandSummary {
    pub hand: String,
    /// Index into `nodes` where hero acts.
    pub node: usize,
    pub equity: f64,
    pub ev: f64,
    pub actions: Vec<HeroAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeroAction {
    pub action: String,
    pub amount: i32,
    pub frequency: f64,
    /// Hero's hand's EV of taking this action, chips (fold = 0; otherwise the share of the
    /// pot hero expects to win minus what hero still puts in from this node on).
    #[serde(default)]
    pub ev: f64,
}

// ---------- error response (SPEC §6 shape) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    /// Always "cant_solve".
    pub status: String,
    pub reason: String,
    pub message: String,
}
