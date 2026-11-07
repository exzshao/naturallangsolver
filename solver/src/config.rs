//! Process settings (env vars) and request → `CardConfig` / `TreeConfig` conversion.

use std::time::Duration;

use postflop_solver::{
    BetSizeOptions, BoardState, Card, CardConfig, NOT_DEALT, Range, TreeConfig, card_from_str,
};

use crate::api::{PlayerSide, SolveRequest};
use crate::error::{Reason, SolveError};

/// Settings read once from the environment at startup.
#[derive(Debug, Clone)]
pub struct Settings {
    pub port: u16,
    pub max_memory_mb: u64,
    pub solve_timeout: Duration,
    pub max_iterations: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: 8080,
            max_memory_mb: 1024,
            solve_timeout: Duration::from_secs(90),
            max_iterations: 1000,
        }
    }
}

impl Settings {
    /// Reads `PORT`, `MAX_MEMORY_MB`, `SOLVE_TIMEOUT_SECS`, `MAX_ITERATIONS`,
    /// falling back to defaults when unset or unparseable.
    pub fn from_env() -> Self {
        fn var<T: std::str::FromStr>(name: &str, default: T) -> T {
            match std::env::var(name) {
                Ok(v) => v.trim().parse().unwrap_or_else(|_| {
                    tracing::warn!("ignoring unparseable {name}={v:?}");
                    default
                }),
                Err(_) => default,
            }
        }
        let d = Self::default();
        Self {
            port: var("PORT", d.port),
            max_memory_mb: var("MAX_MEMORY_MB", d.max_memory_mb),
            solve_timeout: Duration::from_secs(var("SOLVE_TIMEOUT_SECS", d.solve_timeout.as_secs())),
            max_iterations: var("MAX_ITERATIONS", d.max_iterations),
        }
    }
}

/// Splits a board string ("Td9d6hQc2s", spaces allowed) into flop / turn / river.
/// Turn and river are `NOT_DEALT` when absent.
pub fn parse_board(s: &str) -> Result<([Card; 3], Card, Card), SolveError> {
    let bad = |detail: String| SolveError::new(Reason::InvalidBoard, detail);
    let cards = parse_cards(s).map_err(|e| bad(format!("board {s:?}: {e}")))?;
    if !(3..=5).contains(&cards.len()) {
        return Err(bad(format!("board {s:?} has {} cards, expected 3-5", cards.len())));
    }
    let mut flop = [cards[0], cards[1], cards[2]];
    flop.sort_unstable();
    let turn = cards.get(3).copied().unwrap_or(NOT_DEALT);
    let river = cards.get(4).copied().unwrap_or(NOT_DEALT);
    Ok((flop, turn, river))
}

/// Parses a run of 2-char cards (whitespace ignored, suit case-insensitive),
/// rejecting duplicates.
pub fn parse_cards(s: &str) -> Result<Vec<Card>, String> {
    let chars: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.is_empty() || !chars.len().is_multiple_of(2) {
        return Err("expected an even number of characters (2 per card)".into());
    }
    let mut cards = Vec::with_capacity(chars.len() / 2);
    for pair in chars.chunks(2) {
        let text: String = [pair[0], pair[1].to_ascii_lowercase()].iter().collect();
        let card = card_from_str(&text)?;
        if cards.contains(&card) {
            return Err(format!("duplicate card {text}"));
        }
        cards.push(card);
    }
    Ok(cards)
}

pub fn board_state(turn: Card, river: Card) -> BoardState {
    match (turn != NOT_DEALT, river != NOT_DEALT) {
        (false, _) => BoardState::Flop,
        (true, false) => BoardState::Turn,
        (true, true) => BoardState::River,
    }
}

/// Hero's hand, resolved to card ids.
#[derive(Debug, Clone)]
pub struct HeroSpec {
    pub player: PlayerSide,
    /// Sorted (low id, high id), matching `private_cards` ordering.
    pub cards: (Card, Card),
}

/// Everything needed to build the game, validated cheaply up front
/// (before taking the solver permit).
pub struct Prepared {
    pub card_config: CardConfig,
    pub tree_config: TreeConfig,
    pub hero: Option<HeroSpec>,
    pub max_iterations: u32,
    pub target_exploitability_pct: f64,
}

fn chips(v: f64, what: &str) -> Result<i32, SolveError> {
    if !v.is_finite() || v.round() <= 0.0 || v.round() > i32::MAX as f64 / 4.0 {
        return Err(SolveError::new(Reason::InvalidStacks, format!("{what} = {v}")));
    }
    Ok(v.round() as i32)
}

fn bet_sizes(street: &str, bet: &str, raise: &str) -> Result<BetSizeOptions, SolveError> {
    BetSizeOptions::try_from((bet, raise)).map_err(|e| {
        SolveError::new(Reason::InvalidBetSizes, format!("{street} {bet:?}/{raise:?}: {e}"))
    })
}

fn range(which: &str, s: &str) -> Result<Range, SolveError> {
    normalize_range(s)
        .parse::<Range>()
        .map_err(|e| SolveError::new(Reason::InvalidRange, format!("{which} range: {e}")))
}

/// The crate only accepts dash ranges in descending order ("JJ-22", "AJs-A2s").
/// Flip ascending ones ("22-JJ", "A2s-AJs") so either order works.
pub fn normalize_range(s: &str) -> String {
    s.split(',')
        .map(|token| {
            let token = token.trim();
            let (combo, weight) = match token.split_once(':') {
                Some((c, w)) => (c.trim(), Some(w.trim())),
                None => (token, None),
            };
            let combo = match combo.split_once('-') {
                Some((a, b)) if combo.parse::<Range>().is_err() => {
                    let flipped = format!("{}-{}", b.trim(), a.trim());
                    if flipped.parse::<Range>().is_ok() { flipped } else { combo.to_string() }
                }
                _ => combo.to_string(),
            };
            match weight {
                Some(w) => format!("{combo}:{w}"),
                None => combo,
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Converts a request into solver configs. Pure and cheap (no tree build).
pub fn prepare(req: &SolveRequest, settings: &Settings) -> Result<Prepared, SolveError> {
    let (flop, turn, river) = parse_board(&req.board)?;

    let hero = match &req.hero {
        Some(h) => match h.hand.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(hand) => {
                let cards = parse_cards(hand)
                    .ok()
                    .filter(|c| c.len() == 2)
                    .ok_or_else(|| {
                        SolveError::new(Reason::InvalidBoard, format!("hero hand {hand:?} is not 2 distinct cards"))
                    })?;
                let board = [flop[0], flop[1], flop[2], turn, river];
                if cards.iter().any(|c| board.contains(c)) {
                    return Err(SolveError::new(
                        Reason::InvalidBoard,
                        format!("hero hand {hand:?} overlaps board {:?}", req.board),
                    ));
                }
                Some(HeroSpec {
                    player: h.player,
                    cards: (cards[0].min(cards[1]), cards[0].max(cards[1])),
                })
            }
            None => None,
        },
        None => None,
    };

    let oop = range("OOP", &req.oop_range)?;
    let ip = range("IP", &req.ip_range)?;

    let starting_pot = chips(req.starting_pot, "starting_pot")?;
    let effective_stack = chips(req.effective_stack, "effective_stack")?;

    let b = &req.bet_sizes;
    let flop_sizes = bet_sizes("flop", &b.flop.bet, &b.flop.raise)?;
    let turn_sizes = bet_sizes("turn", &b.turn.bet, &b.turn.raise)?;
    let river_sizes = bet_sizes("river", &b.river.bet, &b.river.raise)?;

    let card_config = CardConfig { range: [oop, ip], flop, turn, river };
    let tree_config = TreeConfig {
        initial_state: board_state(turn, river),
        starting_pot,
        effective_stack,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [flop_sizes.clone(), flop_sizes],
        turn_bet_sizes: [turn_sizes.clone(), turn_sizes],
        river_bet_sizes: [river_sizes.clone(), river_sizes],
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 1.5,
        force_allin_threshold: 0.15,
        merging_threshold: 0.1,
    };

    let max_iterations = req
        .max_iterations
        .unwrap_or(settings.max_iterations)
        .clamp(1, settings.max_iterations.max(1));
    let target_exploitability_pct = req
        .target_exploitability_pct
        .filter(|p| p.is_finite() && *p >= 0.0)
        .unwrap_or(0.5);

    Ok(Prepared { card_config, tree_config, hero, max_iterations, target_exploitability_pct })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(s: &str) -> Card {
        card_from_str(s).unwrap()
    }

    #[test]
    fn splits_flop() {
        let (flop, turn, river) = parse_board("Td9d6h").unwrap();
        let mut want = [c("Td"), c("9d"), c("6h")];
        want.sort_unstable();
        assert_eq!(flop, want);
        assert_eq!(turn, NOT_DEALT);
        assert_eq!(river, NOT_DEALT);
        assert_eq!(board_state(turn, river), BoardState::Flop);
    }

    #[test]
    fn splits_turn_and_river() {
        let (_, turn, river) = parse_board("Td9d6hQc").unwrap();
        assert_eq!((turn, river), (c("Qc"), NOT_DEALT));
        assert_eq!(board_state(turn, river), BoardState::Turn);

        let (_, turn, river) = parse_board("Td9d6hQc2s").unwrap();
        assert_eq!((turn, river), (c("Qc"), c("2s")));
        assert_eq!(board_state(turn, river), BoardState::River);
    }

    #[test]
    fn accepts_spaces_and_case() {
        assert_eq!(parse_board("Td 9d 6h Qc 2s").unwrap(), parse_board("Td9d6hQc2s").unwrap());
        assert_eq!(parse_board("tD9D6H").unwrap(), parse_board("Td9d6h").unwrap());
    }

    #[test]
    fn flips_ascending_dash_ranges() {
        assert_eq!(normalize_range("22-JJ, A2s-AJs:0.5,KQo"), "JJ-22,AJs-A2s:0.5,KQo");
        assert_eq!(normalize_range("QQ-88,A9s-A6s"), "QQ-88,A9s-A6s");
        let a: Range = normalize_range("22-JJ,A2s-AJs").parse().unwrap();
        let b: Range = "JJ-22,AJs-A2s".parse().unwrap();
        assert_eq!(a.raw_data(), b.raw_data());
    }

    #[test]
    fn rejects_bad_boards() {
        for b in ["", "Td9d", "Td9d6hQc2s3s", "Td9d6", "Xd9d6h", "Td9x6h", "TdTd6h", "Td9d6h9d", "Td9d6hQc6h"] {
            let err = parse_board(b).unwrap_err();
            assert_eq!(err.reason, Reason::InvalidBoard, "{b:?}");
        }
    }
}
