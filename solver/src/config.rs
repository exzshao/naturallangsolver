//! Process settings (env vars) and request → `CardConfig` / `TreeConfig` conversion.

use std::time::Duration;

use postflop_solver::{
    BetSizeOptions, BoardState, Card, CardConfig, DonkSizeOptions, NOT_DEALT, Range, TreeConfig, card_from_str,
};

use crate::api::{BetSizePair, PlayerSide, PlayerSizes, SolveRequest, StreetBetSizes};
use crate::error::{Reason, SolveError};
use crate::line::{self, LineStatus};
use crate::street::{self, StreetStatus};

/// Shared secret for the `x-solver-key` header. `Debug` never prints the value,
/// so the startup log line can include the settings.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(pub String);

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey(<redacted>)")
    }
}

/// Settings read once from the environment at startup.
#[derive(Debug, Clone)]
pub struct Settings {
    pub port: u16,
    pub max_memory_mb: u64,
    pub solve_timeout: Duration,
    pub max_iterations: u32,
    /// `SOLVER_API_KEY`. When set, every route except `/health` needs a matching
    /// `x-solver-key` header. Unset or empty disables auth (local dev).
    pub api_key: Option<ApiKey>,
    /// `RATE_LIMIT_PER_IP_HOUR`: admits per client IP in any rolling hour.
    pub rate_limit_per_ip_hour: u32,
    /// `RATE_LIMIT_GLOBAL_DAY`: admits across all IPs in any rolling 24 hours.
    pub rate_limit_global_day: u32,
    /// `QUEUE_MAX_WAITING`: requests that may wait behind the running solve.
    /// More than that get `SOLVER_BUSY` right away. 0 disables queueing.
    pub queue_max_waiting: usize,
    /// `QUEUE_MAX_WAIT_SECS`: how long a request may wait in line before
    /// giving up with `SOLVER_BUSY`.
    pub queue_max_wait: Duration,
    /// `RARE_LINE_THRESHOLD`: line probability (share of a player's starting range that
    /// takes the stage-1 line) below which that player's narrowed range is blended
    /// toward the starting range. 0 turns blending off.
    pub rare_line_threshold: f64,
    /// `TREE_BUDGET_SECS`: estimated stage-2 solve time above which a simpler tree is
    /// picked (`solve::pick_tree`).
    pub tree_budget_secs: f64,
    /// `TREE_MS_PER_MB`: estimated solve milliseconds per MB of raw tree storage, to
    /// 0.5% exploitability. Calibrated for the production machine (Fly shared-cpu-4x).
    pub tree_ms_per_mb: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: 8080,
            max_memory_mb: 1024,
            solve_timeout: Duration::from_secs(90),
            max_iterations: 1000,
            api_key: None,
            rate_limit_per_ip_hour: 100,
            rate_limit_global_day: 10_000,
            queue_max_waiting: 5,
            queue_max_wait: Duration::from_secs(120),
            rare_line_threshold: line::RARE_LINE_THRESHOLD,
            tree_budget_secs: TREE_BUDGET_SECS,
            tree_ms_per_mb: TREE_MS_PER_MB,
        }
    }
}

impl Settings {
    /// Reads `PORT`, `MAX_MEMORY_MB`, `SOLVE_TIMEOUT_SECS`, `MAX_ITERATIONS`,
    /// `SOLVER_API_KEY`, `RATE_LIMIT_PER_IP_HOUR`, `RATE_LIMIT_GLOBAL_DAY`,
    /// `QUEUE_MAX_WAITING`, `QUEUE_MAX_WAIT_SECS`, `RARE_LINE_THRESHOLD`, `TREE_BUDGET_SECS`,
    /// `TREE_MS_PER_MB`, falling back to defaults when unset or unparseable.
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
            api_key: std::env::var("SOLVER_API_KEY")
                .ok()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty())
                .map(ApiKey),
            rate_limit_per_ip_hour: var("RATE_LIMIT_PER_IP_HOUR", d.rate_limit_per_ip_hour),
            rate_limit_global_day: var("RATE_LIMIT_GLOBAL_DAY", d.rate_limit_global_day),
            queue_max_waiting: var("QUEUE_MAX_WAITING", d.queue_max_waiting),
            queue_max_wait: Duration::from_secs(var("QUEUE_MAX_WAIT_SECS", d.queue_max_wait.as_secs())),
            rare_line_threshold: {
                let t: f64 = var("RARE_LINE_THRESHOLD", d.rare_line_threshold);
                if t.is_finite() { t.clamp(0.0, 1.0) } else { d.rare_line_threshold }
            },
            tree_budget_secs: positive(var("TREE_BUDGET_SECS", d.tree_budget_secs), d.tree_budget_secs),
            tree_ms_per_mb: positive(var("TREE_MS_PER_MB", d.tree_ms_per_mb), d.tree_ms_per_mb),
        }
    }
}

/// Default `TREE_BUDGET_SECS`: half of the ~60 s a whole request may take on Fly.
pub const TREE_BUDGET_SECS: f64 = 30.0;
/// Default `TREE_MS_PER_MB`. Measured on an M1 (8 GB) on wide BTN-vs-BB / CO-vs-BTN flop
/// trees and 3-bet-pot trees: 13-25 ms per raw MB to 0.5% (60-80 iterations; trees with
/// more raises cost more per MB), ~20 typical. Fly's shared-cpu-4x is ~2x slower.
pub const TREE_MS_PER_MB: f64 = 40.0;

fn positive(v: f64, default: f64) -> f64 {
    if v.is_finite() && v > 0.0 { v } else { default }
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
    /// Stage-2 trees to pick from, richest first: the request's `bet_sizes`, its
    /// `bet_size_fallbacks`, then auto-simplified ones (`solve::pick_tree`). Never empty.
    pub trees: Vec<TreeCandidate>,
    /// Trees the request gave (1 + fallbacks).
    pub given_trees: usize,
    pub hero: Option<HeroSpec>,
    pub max_iterations: u32,
    pub target_exploitability_pct: f64,
    /// Stage-1 narrowing job, or why there isn't one.
    pub line: LineStatus,
    /// Villain's hand is known: villain's player index (its range is that hand and its
    /// street actions get locked).
    pub villain_known: Option<usize>,
}

fn chips(v: f64, what: &str) -> Result<i32, SolveError> {
    if !v.is_finite() || v.round() <= 0.0 || v.round() > i32::MAX as f64 / 4.0 {
        return Err(SolveError::new(Reason::InvalidStacks, format!("{what} = {v}")));
    }
    Ok(v.round() as i32)
}

/// One stage-2 tree: its sizes, the `TreeConfig` (with the current-street sizes of
/// `street_actions` added), and the street walk for it.
#[derive(Debug, Clone)]
pub struct TreeCandidate {
    pub sizes: StreetBetSizes,
    /// Auto-simplification step that made it (`"no_raises"`, `"one_size"`), if any.
    pub auto: Option<&'static str>,
    pub tree_config: TreeConfig,
    /// Walk to hero's decision on the current street, or why there isn't one. When it's a
    /// plan, `tree_config` already has its sizes.
    pub street: StreetStatus,
}

fn bet_sizes(street: &str, pair: &BetSizePair) -> Result<[BetSizeOptions; 2], SolveError> {
    let one = |p: usize| {
        let (bet, raise) = pair.for_player(p);
        BetSizeOptions::try_from((bet, raise)).map_err(|e| {
            SolveError::new(Reason::InvalidBetSizes, format!("{street} {bet:?}/{raise:?}: {e}"))
        })
    };
    Ok([one(0)?, one(1)?])
}

fn donk_sizes(street: &str, pair: &BetSizePair) -> Result<Option<DonkSizeOptions>, SolveError> {
    pair.donk
        .as_deref()
        .map(|d| {
            DonkSizeOptions::try_from(d)
                .map_err(|e| SolveError::new(Reason::InvalidBetSizes, format!("{street} donk {d:?}: {e}")))
        })
        .transpose()
}

/// `base` with the sizes (bets, raises, donks) from `sizes`.
pub fn with_sizes(base: &TreeConfig, sizes: &StreetBetSizes) -> Result<TreeConfig, SolveError> {
    Ok(TreeConfig {
        flop_bet_sizes: bet_sizes("flop", &sizes.flop)?,
        turn_bet_sizes: bet_sizes("turn", &sizes.turn)?,
        river_bet_sizes: bet_sizes("river", &sizes.river)?,
        turn_donk_sizes: donk_sizes("turn", &sizes.turn)?,
        river_donk_sizes: donk_sizes("river", &sizes.river)?,
        ..base.clone()
    })
}

fn map_pairs(sizes: &StreetBetSizes, f: impl Fn(&BetSizePair) -> BetSizePair) -> StreetBetSizes {
    StreetBetSizes { flop: f(&sizes.flop), turn: f(&sizes.turn), river: f(&sizes.river) }
}

/// Auto-simplify step 1: no raises for anyone, on any street.
pub fn drop_raises(sizes: &StreetBetSizes) -> StreetBetSizes {
    let strip = |o: &Option<PlayerSizes>| {
        o.as_ref().map(|o| PlayerSizes { bet: o.bet.clone(), raise: o.raise.as_ref().map(|_| String::new()) })
    };
    map_pairs(sizes, |p| BetSizePair { raise: String::new(), oop: strip(&p.oop), ip: strip(&p.ip), ..p.clone() })
}

/// The first size of a comma list that isn't all-in (`a`); the list as is if there is none.
fn first_size(list: &str) -> String {
    list.split(',')
        .map(str::trim)
        .find(|x| !x.is_empty() && !x.eq_ignore_ascii_case("a"))
        .map_or_else(|| list.trim().to_string(), str::to_string)
}

/// Auto-simplify step 2: one bet size per street and player (the first listed, all-in
/// dropped when there's another), donk lists too.
pub fn one_size(sizes: &StreetBetSizes) -> StreetBetSizes {
    let first = |o: &Option<PlayerSizes>| {
        o.as_ref().map(|o| PlayerSizes { bet: o.bet.as_deref().map(first_size), raise: o.raise.clone() })
    };
    map_pairs(sizes, |p| BetSizePair {
        bet: first_size(&p.bet),
        raise: p.raise.clone(),
        oop: first(&p.oop),
        ip: first(&p.ip),
        donk: p.donk.as_deref().map(first_size),
    })
}

/// The request's trees plus the auto-simplified ones, each with its `TreeConfig` and
/// street walk. Errors on a given tree whose sizes don't parse.
fn tree_candidates(
    req: &SolveRequest,
    base: &TreeConfig,
) -> Result<(Vec<TreeCandidate>, usize), SolveError> {
    let mut list: Vec<(StreetBetSizes, Option<&'static str>)> = vec![(req.bet_sizes.clone(), None)];
    for f in req.bet_size_fallbacks.iter().flatten() {
        list.push((f.clone(), None));
    }
    let given = list.len();
    let last = list[given - 1].0.clone();
    let no_raises = drop_raises(&last);
    let one = one_size(&no_raises);
    for (sizes, step) in [(no_raises, "no_raises"), (one, "one_size")] {
        if list.iter().all(|(s, _)| *s != sizes) {
            list.push((sizes, Some(step)));
        }
    }
    let hero = req.hero.as_ref().map(|h| h.player);
    list.into_iter()
        .map(|(sizes, auto)| {
            let mut tree_config = with_sizes(base, &sizes)?;
            let street = street::plan(req.street_actions.as_deref(), hero, &mut tree_config);
            Ok(TreeCandidate { sizes, auto, tree_config, street })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|v| (v, given))
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

    let mut oop = range("OOP", &req.oop_range)?;
    let mut ip = range("IP", &req.ip_range)?;

    // Known villain hand: villain's range is exactly those combos.
    let mut villain_known = None;
    if let Some(text) = req.villain_hand.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let Some(hero_side) = req.hero.as_ref().map(|h| h.player) else {
            return Err(SolveError::new(Reason::InvalidRequest, "villain_hand needs hero"));
        };
        let board = [flop[0], flop[1], flop[2], turn, river];
        let r = villain_range(text, &board, hero.as_ref())?;
        let v = hero_side.index() ^ 1;
        if v == 0 { oop = r } else { ip = r }
        villain_known = Some(v);
    }

    let starting_pot = chips(req.starting_pot, "starting_pot")?;
    let effective_stack = chips(req.effective_stack, "effective_stack")?;

    let card_config = CardConfig { range: [oop, ip], flop, turn, river };
    let base = TreeConfig {
        initial_state: board_state(turn, river),
        starting_pot,
        effective_stack,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: Default::default(),
        turn_bet_sizes: Default::default(),
        river_bet_sizes: Default::default(),
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 1.5,
        force_allin_threshold: 0.15,
        merging_threshold: 0.1,
    };
    let (trees, given_trees) = tree_candidates(req, &base)?;

    let max_iterations = req
        .max_iterations
        .unwrap_or(settings.max_iterations)
        .clamp(1, settings.max_iterations.max(1));
    let target_exploitability_pct = req
        .target_exploitability_pct
        .filter(|p| p.is_finite() && *p >= 0.0)
        .unwrap_or(0.5);

    let line = if villain_known.is_some() && req.line.as_ref().is_some_and(|l| !l.is_empty()) {
        LineStatus::Skip("villain's hand is known".into())
    } else {
        line::plan(
            req.line.as_deref(),
            req.flop_pot,
            req.flop_stack,
            &card_config,
            &base,
            settings.max_iterations,
            req.preflop_aggressor.map(PlayerSide::index),
        )
    };

    Ok(Prepared {
        card_config,
        trees,
        given_trees,
        hero,
        max_iterations,
        target_exploitability_pct,
        line,
        villain_known,
    })
}

/// Villain's known hand as a range: exact cards ("7c2d", either order) or a hand class
/// ("72o", "27o", "72s", "77", "72"). INVALID_BOARD when it overlaps the board or hero's
/// hand (no live combo left), or doesn't parse.
pub fn villain_range(text: &str, board: &[Card; 5], hero: Option<&HeroSpec>) -> Result<Range, SolveError> {
    let bad = |detail: String| SolveError::new(Reason::InvalidBoard, detail);
    let mut dead: u64 = board.iter().filter(|&&c| c != NOT_DEALT).fold(0, |m, &c| m | (1u64 << c));
    if let Some(h) = hero {
        dead |= (1u64 << h.cards.0) | (1u64 << h.cards.1);
    }
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let mut r = Range::new();
    if let Ok(cards) = parse_cards(&compact)
        && cards.len() == 2
    {
        if cards.iter().any(|&c| dead & (1u64 << c) != 0) {
            return Err(bad(format!("villain hand {text:?} overlaps the board or hero's hand")));
        }
        r.set_weight_by_cards(cards[0].min(cards[1]), cards[0].max(cards[1]), 1.0);
        return Ok(r);
    }
    // Hand class; ranks in either order.
    let mut chars: Vec<char> = compact.chars().collect();
    const ORDER: &str = "23456789TJQKA";
    if chars.len() >= 2 {
        chars[0] = chars[0].to_ascii_uppercase();
        chars[1] = chars[1].to_ascii_uppercase();
        if let (Some(a), Some(b)) = (ORDER.find(chars[0]), ORDER.find(chars[1]))
            && a < b
        {
            chars.swap(0, 1);
        }
    }
    let class: String = chars.into_iter().collect();
    if class.len() > 3 || class.contains(',') {
        return Err(bad(format!("villain hand {text:?} isn't two cards or one hand class")));
    }
    let parsed: Range = class.parse().map_err(|e| bad(format!("villain hand {text:?}: {e}")))?;
    let (hands, weights) = parsed.get_hands_weights(dead);
    let mut live = 0;
    for (&(c1, c2), &w) in hands.iter().zip(&weights) {
        if w > 0.0 && dead & ((1u64 << c1) | (1u64 << c2)) == 0 {
            r.set_weight_by_cards(c1, c2, 1.0);
            live += 1;
        }
    }
    if live == 0 {
        return Err(bad(format!("every {class} combo overlaps the board or hero's hand")));
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_limits_and_redacted_key() {
        let d = Settings::default();
        assert_eq!((d.rate_limit_per_ip_hour, d.rate_limit_global_day), (100, 10_000));
        assert_eq!((d.queue_max_waiting, d.queue_max_wait), (5, Duration::from_secs(120)));
        assert!(d.api_key.is_none());
        assert_eq!(d.rare_line_threshold, 0.05);
        let s = Settings { api_key: Some(ApiKey("hunter2".into())), ..d };
        assert!(!format!("{s:?}").contains("hunter2"));
    }

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
    fn villain_hands_become_exact_ranges() {
        let board = {
            let (f, t, r) = parse_board("Td9d6h").unwrap();
            [f[0], f[1], f[2], t, r]
        };
        let hero = HeroSpec { player: PlayerSide::Ip, cards: (c("Kh"), c("Ah")) };
        let combos = |r: &Range| r.get_hands_weights(0).1.iter().filter(|&&w| w > 0.0).count();
        assert_eq!(combos(&villain_range("72o", &board, Some(&hero)).unwrap()), 12);
        assert_eq!(combos(&villain_range("27 o", &board, Some(&hero)).unwrap()), 12);
        assert_eq!(combos(&villain_range("72s", &board, Some(&hero)).unwrap()), 4);
        assert_eq!(combos(&villain_range("72", &board, Some(&hero)).unwrap()), 16);
        // Hero holds AhKh: AK offsuit loses the six combos with either card.
        assert_eq!(combos(&villain_range("AKo", &board, Some(&hero)).unwrap()), 6);
        // TT: only three tens left, one on the board -> 3 combos.
        assert_eq!(combos(&villain_range("TT", &board, Some(&hero)).unwrap()), 3);
        let exact = villain_range("2d7c", &board, Some(&hero)).unwrap();
        assert_eq!(exact.get_weight_by_cards(c("2d"), c("7c")), 1.0);
        assert_eq!(combos(&exact), 1);
        for bad in ["Td7c", "Ah2c", "zz", "72o,73o", "7c"] {
            let e = villain_range(bad, &board, Some(&hero)).unwrap_err();
            assert_eq!(e.reason, Reason::InvalidBoard, "{bad}");
        }
        // Every combo blocked: one six left on 6h6d6c.
        let b3 = {
            let (f, t, r) = parse_board("6h6d6c").unwrap();
            [f[0], f[1], f[2], t, r]
        };
        assert_eq!(villain_range("66", &b3, None).unwrap_err().reason, Reason::InvalidBoard);
    }

    fn sizes(v: serde_json::Value) -> StreetBetSizes {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn auto_simplify_drops_raises_then_extra_sizes() {
        let rich = sizes(serde_json::json!({
            "flop": {"bet": "33%, 75%", "raise": "", "oop": {"bet": "", "raise": "3x"}},
            "turn": {"bet": "a, 75%", "raise": "3x", "donk": "50%, 25%"},
            "river": {"bet": "a", "raise": "2x, a", "ip": {"bet": "60%, 30%"}}
        }));
        let nr = drop_raises(&rich);
        assert_eq!(nr.flop.for_player(0), ("", ""));
        assert_eq!(nr.flop.for_player(1), ("33%, 75%", ""));
        assert_eq!(nr.turn.for_player(0), ("a, 75%", ""));
        assert_eq!(nr.river.for_player(1), ("60%, 30%", ""));
        let one = one_size(&nr);
        assert_eq!(one.flop.for_player(1), ("33%", ""));
        assert_eq!(one.flop.for_player(0), ("", ""));
        assert_eq!(one.turn.for_player(0), ("75%", ""));
        assert_eq!(one.turn.donk.as_deref(), Some("50%"));
        // A list that is only all-in stays.
        assert_eq!(one.river.for_player(0), ("a", ""));
        assert_eq!(one.river.for_player(1), ("60%", ""));
    }

    #[test]
    fn per_player_sizes_and_donks_reach_the_tree() {
        let req: SolveRequest = serde_json::from_value(serde_json::json!({
            "board": "Td9d6h", "oop_range": "AA", "ip_range": "KK", "starting_pot": 550, "effective_stack": 9750,
            "bet_sizes": {
                "flop": {"bet": "33%", "raise": "", "oop": {"bet": "", "raise": "3x"}},
                "turn": {"bet": "75%", "raise": "", "donk": ""},
                "river": {"bet": "75%", "raise": ""}
            },
            "bet_size_fallbacks": [{
                "flop": {"bet": "33%", "raise": ""}, "turn": {"bet": "75%", "raise": ""}, "river": {"bet": "75%", "raise": ""}
            }],
            "preflop_aggressor": "ip"
        }))
        .unwrap();
        let p = prepare(&req, &Settings::default()).unwrap();
        // Given: 2 trees. The fallback has no raises already and one size, so no auto trees.
        assert_eq!((p.given_trees, p.trees.len()), (2, 2));
        let t = &p.trees[0].tree_config;
        assert_eq!(t.flop_bet_sizes[0], BetSizeOptions::try_from(("", "3x")).unwrap());
        assert_eq!(t.flop_bet_sizes[1], BetSizeOptions::try_from(("33%", "")).unwrap());
        assert_eq!(t.turn_donk_sizes, Some(DonkSizeOptions { donk: vec![] }));
        assert_eq!(t.river_donk_sizes, None);

        let mut bad = req.clone();
        bad.bet_size_fallbacks.as_mut().unwrap()[0].river.donk = Some("3x".into());
        assert_eq!(prepare(&bad, &Settings::default()).err().unwrap().reason, Reason::InvalidBetSizes);

        // Without fallbacks: the request's tree, then raises dropped, then one size.
        let mut auto = req.clone();
        auto.bet_size_fallbacks = None;
        auto.bet_sizes.flop.bet = "33%, 75%".into();
        let p = prepare(&auto, &Settings::default()).unwrap();
        let steps: Vec<_> = p.trees.iter().map(|t| t.auto).collect();
        assert_eq!(steps, vec![None, Some("no_raises"), Some("one_size")]);
        assert_eq!(p.trees[2].sizes.flop.for_player(1), ("33%", ""));
    }

    #[test]
    fn rejects_bad_boards() {
        for b in ["", "Td9d", "Td9d6hQc2s3s", "Td9d6", "Xd9d6h", "Td9x6h", "TdTd6h", "Td9d6h9d", "Td9d6hQc6h"] {
            let err = parse_board(b).unwrap_err();
            assert_eq!(err.reason, Reason::InvalidBoard, "{b:?}");
        }
    }
}
