//! Turn a finalized `PostFlopGame` into the compact §7 summary.

use postflop_solver::{Action, PostFlopGame, compute_average, holes_to_strings};

use crate::api::{
    ActionSummary, HandClass, HeroAction, HeroHandSummary, NodeSummary, PlayerSide, PlayerStats, Players,
};
use crate::config::HeroSpec;
use crate::error::{Reason, SolveError};
use crate::solve::round;

const TOP_CLASSES: usize = 6;

const RANKS: &[u8; 13] = b"23456789TJQKA";

/// Hand-class name for a hole-card pair (card id = 4 * rank + suit): "KK", "KQs", "KQo".
pub fn class_name(cards: (u8, u8)) -> String {
    let (r1, r2) = (cards.0 / 4, cards.1 / 4);
    let (hi, lo) = if r1 >= r2 { (r1, r2) } else { (r2, r1) };
    let mut s = String::with_capacity(3);
    s.push(RANKS[hi as usize] as char);
    s.push(RANKS[lo as usize] as char);
    if hi != lo {
        s.push(if cards.0 % 4 == cards.1 % 4 { 's' } else { 'o' });
    }
    s
}

/// Groups combos into hand classes for one action. `weights` are the player's range
/// weights at the node and `row` the per-combo probability of taking the action.
/// Returns up to `limit` classes ordered by how often they take the action
/// (weighted-average frequency over live combos, compared at 1% resolution), ties
/// broken by weight sent into the action (sum of weight * freq).
/// Zero-weight combos (blocked or not in range) are ignored.
pub fn top_classes(hands: &[(u8, u8)], weights: &[f32], row: &[f32], limit: usize) -> Vec<HandClass> {
    // class -> (sum of weight * freq, sum of weight)
    let mut acc: Vec<(String, f64, f64)> = Vec::new();
    for ((&cards, &w), &s) in hands.iter().zip(weights).zip(row) {
        if w <= 0.0 {
            continue;
        }
        let name = class_name(cards);
        let (w, s) = (w as f64, s as f64);
        match acc.iter_mut().find(|c| c.0 == name) {
            Some(c) => {
                c.1 += w * s;
                c.2 += w;
            }
            None => acc.push((name, w * s, w)),
        }
    }
    acc.retain(|c| c.1 > 0.0);
    let pct = |c: &(String, f64, f64)| (c.1 / c.2 * 100.0).round();
    acc.sort_by(|a, b| {
        pct(b).total_cmp(&pct(a)).then_with(|| b.1.total_cmp(&a.1)).then_with(|| a.0.cmp(&b.0))
    });
    acc.into_iter()
        .take(limit)
        .map(|(hand, mass, w)| HandClass { hand, frequency: round(mass / w, 4) })
        .collect()
}

pub fn action_parts(a: &Action) -> (String, i32) {
    match *a {
        Action::Fold => ("Fold".into(), 0),
        Action::Check => ("Check".into(), 0),
        Action::Call => ("Call".into(), 0),
        Action::Bet(x) => ("Bet".into(), x),
        Action::Raise(x) => ("Raise".into(), x),
        Action::AllIn(x) => ("AllIn".into(), x),
        ref other => (format!("{other:?}"), 0),
    }
}

/// Reads the current node (weights must already be cached).
fn read_node(
    game: &PostFlopGame,
    line: Vec<String>,
    hero: Option<&HeroSpec>,
    node_index: usize,
) -> Result<(NodeSummary, Option<HeroHandSummary>), SolveError> {
    let player = game.current_player();
    let actions = game.available_actions();
    let strategy = game.strategy();
    let hands = game.private_cards(player);
    let n = hands.len();
    let weights = game.normalized_weights(player);
    let total: f64 = weights.iter().map(|&w| w as f64).sum();
    let names = holes_to_strings(hands).map_err(|e| SolveError::new(Reason::Internal, e))?;

    let mut out = Vec::with_capacity(actions.len());
    for (a, action) in actions.iter().enumerate() {
        let row = &strategy[a * n..(a + 1) * n];
        let mass: f64 = row.iter().zip(weights).map(|(&s, &w)| s as f64 * w as f64).sum();
        let freq = if total > 0.0 { round(mass / total, 4) } else { 0.0 };
        let top_classes =
            if freq > 0.0 { top_classes(hands, weights, row, TOP_CLASSES) } else { Vec::new() };
        let top_hands = top_classes.iter().map(|c| c.hand.clone()).collect();
        let (name, amount) = action_parts(action);
        out.push(ActionSummary { action: name, amount, frequency: freq, top_hands, top_classes });
    }

    let hero_summary = match hero {
        Some(h) if h.player.index() == player => {
            hands.iter().position(|&hc| hc == h.cards).map(|i| {
                let equity = game.equity(player)[i] as f64;
                let ev = game.expected_values(player)[i] as f64;
                HeroHandSummary {
                    hand: names[i].clone(),
                    node: node_index,
                    equity: round(equity, 4),
                    ev: round(ev, 2),
                    actions: actions
                        .iter()
                        .enumerate()
                        .map(|(a, action)| {
                            let (name, amount) = action_parts(action);
                            HeroAction {
                                action: name,
                                amount,
                                frequency: round(strategy[a * n + i] as f64, 4),
                            }
                        })
                        .collect(),
                }
            })
        }
        _ => None,
    };

    Ok((
        NodeSummary { line, player: PlayerSide::from_index(player), actions: out },
        hero_summary,
    ))
}

/// Root stats for both players, plus the root node (OOP) and the node where IP faces a check.
pub fn extract(
    game: &mut PostFlopGame,
    hero: Option<&HeroSpec>,
) -> Result<(Players, Vec<NodeSummary>, Option<HeroHandSummary>), SolveError> {
    game.back_to_root();
    game.cache_normalized_weights();

    let stats = |game: &PostFlopGame, p: usize| {
        let w = game.normalized_weights(p);
        PlayerStats {
            equity: round(compute_average(&game.equity(p), w) as f64, 4),
            ev: round(compute_average(&game.expected_values(p), w) as f64, 2),
        }
    };
    let players = Players { oop: stats(game, 0), ip: stats(game, 1) };

    let mut nodes = Vec::with_capacity(2);
    let (root, mut hero_summary) = read_node(game, vec![], hero, 0)?;
    nodes.push(root);

    if let Some(check) = game.available_actions().iter().position(|a| *a == Action::Check) {
        game.play(check);
        if !game.is_terminal_node() && !game.is_chance_node() {
            game.cache_normalized_weights();
            let (node, h) = read_node(game, vec!["Check".into()], hero, 1)?;
            nodes.push(node);
            hero_summary = hero_summary.or(h);
        }
        game.back_to_root();
    }

    Ok((players, nodes, hero_summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    // card id = 4 * rank + suit; rank 2=0 .. A=12, suits c,d,h,s = 0..3
    fn c(rank: char, suit: char) -> u8 {
        let r = RANKS.iter().position(|&x| x as char == rank).unwrap() as u8;
        let s = "cdhs".find(suit).unwrap() as u8;
        4 * r + s
    }

    #[test]
    fn names_pairs_suited_offsuit() {
        assert_eq!(class_name((c('K', 's'), c('K', 'h'))), "KK");
        assert_eq!(class_name((c('Q', 'h'), c('K', 'h'))), "KQs");
        assert_eq!(class_name((c('K', 'd'), c('Q', 'c'))), "KQo");
        assert_eq!(class_name((c('5', 's'), c('A', 's'))), "A5s");
        assert_eq!(class_name((c('T', 'c'), c('2', 'd'))), "T2o");
    }

    #[test]
    fn groups_and_weights_frequencies() {
        let hands = [
            (c('K', 's'), c('K', 'h')), // KK
            (c('K', 'd'), c('K', 'c')), // KK
            (c('K', 'h'), c('Q', 'h')), // KQs
            (c('K', 's'), c('Q', 's')), // KQs
            (c('K', 'd'), c('Q', 'c')), // KQo
            (c('A', 'h'), c('5', 'h')), // A5s, zero weight (blocked)
            (c('7', 'c'), c('2', 'd')), // 72o, never takes the action
        ];
        let weights = [1.0, 1.0, 1.0, 0.5, 1.0, 0.0, 1.0];
        let row = [1.0, 1.0, 1.0, 0.25, 0.5, 1.0, 0.0];
        let out = top_classes(&hands, &weights, &row, 6);
        // contributions: KK 2.0, KQs 1.125, KQo 0.5; A5s blocked, 72o contributes 0
        let names: Vec<_> = out.iter().map(|h| h.hand.as_str()).collect();
        assert_eq!(names, ["KK", "KQs", "KQo"]);
        assert_eq!(out[0].frequency, 1.0);
        assert_eq!(out[1].frequency, 0.75); // (1*1 + 0.5*0.25) / 1.5
        assert_eq!(out[2].frequency, 0.5);
        assert_eq!(top_classes(&hands, &weights, &row, 2).len(), 2);
    }
}
