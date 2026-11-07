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
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreetBetSizes {
    pub flop: BetSizePair,
    pub turn: BetSizePair,
    pub river: BetSizePair,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BetSizePair {
    pub bet: String,
    pub raise: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionSummary {
    /// "Fold" | "Check" | "Call" | "Bet" | "Raise" | "AllIn"
    pub action: String,
    /// Chips; 0 for Fold/Check/Call.
    pub amount: i32,
    pub frequency: f64,
    pub top_hands: Vec<String>,
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
}

// ---------- error response (SPEC §6 shape) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    /// Always "cant_solve".
    pub status: String,
    pub reason: String,
    pub message: String,
}
