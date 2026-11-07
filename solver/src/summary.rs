//! Turn a finalized `PostFlopGame` into the compact §7 summary.

use postflop_solver::{Action, PostFlopGame, compute_average, holes_to_strings};

use crate::api::{
    ActionSummary, HeroAction, HeroHandSummary, NodeSummary, PlayerSide, PlayerStats, Players,
};
use crate::config::HeroSpec;
use crate::error::{Reason, SolveError};
use crate::solve::round;

const TOP_HANDS: usize = 5;

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
        let mut mass: Vec<(f64, usize)> = row
            .iter()
            .zip(weights)
            .enumerate()
            .map(|(h, (&s, &w))| (s as f64 * w as f64, h))
            .collect();
        let freq = if total > 0.0 { mass.iter().map(|m| m.0).sum::<f64>() / total } else { 0.0 };
        let freq = round(freq, 4);
        mass.sort_by(|x, y| y.0.total_cmp(&x.0));
        let top_hands = mass
            .iter()
            .take_while(|m| m.0 > 0.0 && freq > 0.0)
            .take(TOP_HANDS)
            .map(|m| names[m.1].clone())
            .collect();
        let (name, amount) = action_parts(action);
        out.push(ActionSummary { action: name, amount, frequency: freq, top_hands });
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
