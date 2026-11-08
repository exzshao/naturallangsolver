//! Current-street action (SPEC §7 "street_actions"). A spot like "he bets 75%, should I
//! call?" carries the action on the current street before hero's decision. `plan` (cheap,
//! in `config::prepare`) checks it and adds each size it used to the acting player's
//! options on the current street, so the stage-2 tree has the exact sizes. After the
//! solve, `walk` plays the actions to hero's decision, which is the node reported.
//!
//! Like narrowing, this never fails the request: a problem becomes a reason and the
//! street is reported from its start, as without `street_actions`.

use postflop_solver::{Action, BetSize, BetSizeOptions, BoardState, PostFlopGame, TreeConfig};
use serde_json::Value;

use crate::api::{LineSize, PlayerSide};
use crate::line::{LineAction, LineKind, LineStreet, Want, pct_size, raise_size};

/// Raise hero gets at the decision when facing a bet and the street has no raise sizes
/// (flop spots), as a multiple of the bet: so "fold / call / raise" can be compared. An
/// all-in raise is added too. Both are added only at hero's decision node (not to every
/// branch of the street), which keeps the flop tree within memory.
pub const FACING_RAISE_X: f64 = 3.0;
/// Villain range weight (weighted combos) at hero's decision below which the solver's
/// villain is taken to (almost) never play the line: the street is re-solved with
/// villain's whole range locked into the street actions.
pub const MIN_LINE_COMBOS: f64 = 1.0;
/// The locked re-solve only starts with at least this share of `SOLVE_TIMEOUT_SECS` left.
pub const RESOLVE_TIME_SHARE: f64 = 0.25;
const STREETS: [&str; 3] = ["flop", "turn", "river"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreetStep {
    pub player: usize,
    pub want: Want,
    /// Index into `StreetPlan::sizes` for bets, raises and all-ins.
    pub size: Option<usize>,
}

/// A validated walk to hero's decision on the current street.
#[derive(Debug, Clone)]
pub struct StreetPlan {
    /// Ends with villain's action; hero acts next.
    pub steps: Vec<StreetStep>,
    pub sizes: Vec<LineSize>,
    pub hero: usize,
    /// Lines (`ActionTree::add_line`) giving hero raise options at the decision only.
    pub extra_lines: Vec<Vec<Action>>,
}

#[derive(Debug, Clone)]
pub enum StreetStatus {
    /// No street actions in the request.
    None,
    /// Street actions given but unusable; reported from the start of the street.
    Skip(String),
    Plan(StreetPlan),
}

fn side(p: usize) -> &'static str {
    if p == 0 { "OOP" } else { "IP" }
}

fn street_index(state: BoardState) -> usize {
    match state {
        BoardState::Flop => 0,
        BoardState::Turn => 1,
        BoardState::River => 2,
    }
}

fn one_size(s: &str, raise: bool) -> BetSize {
    let opts = if raise { BetSizeOptions::try_from(("", s)) } else { BetSizeOptions::try_from((s, "")) };
    let opts = opts.expect("generated sizes parse");
    if raise { opts.raise[0] } else { opts.bet[0] }
}

/// Checks the street actions and, on success, adds their sizes to `tree`'s current-street
/// options for the player who used them (plus a raise option for hero facing a bet).
/// `tree` is left untouched when the actions are skipped.
pub fn plan(raw: Option<&[Value]>, hero: Option<PlayerSide>, tree: &mut TreeConfig) -> StreetStatus {
    match raw {
        None | Some([]) => StreetStatus::None,
        Some(raw) => match hero {
            None => StreetStatus::Skip("no hero seat was given".into()),
            Some(h) => match build(raw, h.index(), tree) {
                Ok((p, new_tree)) => {
                    *tree = new_tree;
                    StreetStatus::Plan(p)
                }
                Err(reason) => StreetStatus::Skip(reason),
            },
        },
    }
}

fn build(raw: &[Value], hero: usize, tree: &TreeConfig) -> Result<(StreetPlan, TreeConfig), String> {
    let s = street_index(tree.initial_state);
    let name = STREETS[s];
    let mut options = match s {
        0 => tree.flop_bet_sizes.clone(),
        1 => tree.turn_bet_sizes.clone(),
        _ => tree.river_bet_sizes.clone(),
    };
    let original = options.clone();
    let pot = tree.starting_pot;
    let stack = tree.effective_stack;

    let mut steps = Vec::with_capacity(raw.len());
    let mut path = Vec::with_capacity(raw.len());
    let mut sizes = Vec::new();
    let mut put = [0i32; 2];
    let mut to_act = 0usize;
    let mut added_any = false;
    for (i, v) in raw.iter().enumerate() {
        let e: LineAction = serde_json::from_value(v.clone())
            .map_err(|e| format!("{name} action {} couldn't be read ({e})", i + 1))?;
        let street_ok = matches!((e.street, s), (LineStreet::Flop, 0) | (LineStreet::Turn, 1) | (LineStreet::River, 2));
        if !street_ok {
            return Err(format!("an action given for the {name} is on another street"));
        }
        let p = e.player.index();
        if p != to_act {
            return Err(format!("the {name} action is out of turn ({} acted when {} was due)", side(p), side(to_act)));
        }
        if put[p ^ 1] >= stack {
            return Err(format!("the {name} action continues after an all-in"));
        }
        let facing = put[p ^ 1] > put[p];
        let (want, size) = match e.action {
            LineKind::Fold => return Err(format!("the {name} action has a fold, so there's no decision left")),
            LineKind::Call => return Err(format!("the {name} action has a call, which ends the street")),
            LineKind::Check => {
                if facing {
                    return Err(format!("the {name} action has a check facing a bet"));
                }
                if p == 1 {
                    return Err(format!("both players checked the {name}, so the street is over"));
                }
                path.push(Action::Check);
                (Want::Check, None)
            }
            kind => {
                let amount = match kind {
                    LineKind::Allin => stack,
                    _ => match e.amount_chips {
                        Some(x) if x.is_finite() && x.round() > 0.0 => (x.round() as i64).min(stack as i64) as i32,
                        _ => return Err(format!("a {name} bet has no usable amount")),
                    },
                };
                if facing && amount <= put[p ^ 1] {
                    return Err(format!("a {name} raise isn't bigger than the bet before it"));
                }
                let opts = &mut options[p];
                let (want, label, size_str, is_default, list_is_raise) = if amount >= stack {
                    let has = if facing { opts.raise.contains(&BetSize::AllIn) } else { opts.bet.contains(&BetSize::AllIn) };
                    (Want::AllIn, "allin", "a".to_string(), has, facing)
                } else if facing {
                    let prev = put[p ^ 1];
                    let has = opts.raise.iter().any(|b| match *b {
                        BetSize::PrevBetRelative(r) => (prev as f64 * r).round() as i32 == amount,
                        _ => false,
                    });
                    (Want::Raise(amount), "raise", raise_size(amount, prev), has, true)
                } else {
                    let has = opts.bet.iter().any(|b| match *b {
                        BetSize::PotRelative(r) => (pot as f64 * r).round() as i32 == amount,
                        BetSize::Additive(c, _) => c == amount,
                        _ => false,
                    });
                    (Want::Bet(amount), "bet", pct_size(amount, pot), has, false)
                };
                if !is_default {
                    let b = one_size(&size_str, list_is_raise);
                    let list = if list_is_raise { &mut opts.raise } else { &mut opts.bet };
                    if !list.contains(&b) {
                        list.push(b);
                    }
                    added_any = true;
                }
                sizes.push(LineSize {
                    street: name.into(),
                    player: e.player,
                    action: label.into(),
                    requested: amount,
                    used: None,
                    size: size_str,
                    added: !is_default,
                });
                put[p] = amount;
                path.push(match want {
                    Want::Bet(x) => Action::Bet(x),
                    Want::Raise(x) => Action::Raise(x),
                    _ => Action::AllIn(stack),
                });
                (want, Some(sizes.len() - 1))
            }
        };
        steps.push(StreetStep { player: p, want, size });
        to_act ^= 1;
    }
    if to_act != hero {
        return Err(format!("the {name} action doesn't end with your decision"));
    }

    // Hero facing a bet gets a raise (when the street has none) and an all-in raise at the
    // decision node, so "fold / call / raise" can be compared. Not when villain is all-in.
    // Lines the tree already has are skipped when added (`ActionTree::add_line` errors).
    let villain = hero ^ 1;
    let mut extra_lines = Vec::new();
    if put[villain] > put[hero] && put[villain] < stack {
        if options[hero].raise.iter().all(|b| *b == BetSize::AllIn) {
            let to = (put[villain] as f64 * FACING_RAISE_X).round() as i32;
            if to < stack {
                extra_lines.push([path.as_slice(), &[Action::Raise(to)]].concat());
            }
        }
        extra_lines.push([path.as_slice(), &[Action::AllIn(stack)]].concat());
    }

    for opts in &mut options {
        opts.bet.sort_unstable_by(|l, r| l.partial_cmp(r).unwrap());
        opts.raise.sort_unstable_by(|l, r| l.partial_cmp(r).unwrap());
    }
    let mut new_tree = tree.clone();
    if added_any || options != original {
        match s {
            0 => new_tree.flop_bet_sizes = options,
            1 => new_tree.turn_bet_sizes = options,
            _ => new_tree.river_bet_sizes = options,
        }
        // No merging, so the exact sizes stay next to close defaults.
        new_tree.merging_threshold = 0.0;
    }
    Ok((StreetPlan { steps, sizes, hero, extra_lines }, new_tree))
}

pub const MISMATCH: &str = "the action couldn't be matched in the solver's tree";

/// Index of the action matching `want` at the current node, and the chips it bets for
/// sized actions. Bets/raises take the closest size within 10%, else all-in (a size
/// the tree turned into all-in).
pub fn find(game: &PostFlopGame, want: Want) -> Option<(usize, Option<i32>)> {
    let actions = game.available_actions();
    let allin = actions.iter().enumerate().find_map(|(i, a)| match *a {
        Action::AllIn(x) => Some((i, Some(x))),
        _ => None,
    });
    match want {
        Want::Check => actions.iter().position(|a| *a == Action::Check).map(|i| (i, None)),
        Want::Call => actions.iter().position(|a| *a == Action::Call).map(|i| (i, None)),
        Want::AllIn => allin,
        Want::Bet(x) | Want::Raise(x) => {
            let bet = matches!(want, Want::Bet(_));
            let closest = actions
                .iter()
                .enumerate()
                .filter_map(|(i, a)| match (*a, bet) {
                    (Action::Bet(y), true) | (Action::Raise(y), false) => Some((i, y)),
                    _ => None,
                })
                .min_by_key(|&(_, y)| (y - x).abs());
            match closest {
                Some((i, y)) if (y - x).abs() as f64 <= (x as f64 * 0.1).max(1.0) => Some((i, Some(y))),
                _ => allin,
            }
        }
    }
}

/// Plays `steps` from the root, filling `used` on `sizes`. `on_step(game, player,
/// action_index)` runs at each decision before it is played (used to lock strategies
/// before the solve). Doesn't check where it ends.
pub fn play_steps(
    game: &mut PostFlopGame,
    steps: &[StreetStep],
    sizes: &mut [LineSize],
    mut on_step: impl FnMut(&mut PostFlopGame, usize, usize),
) -> Result<(), String> {
    for step in steps {
        if game.is_terminal_node() || game.is_chance_node() || game.current_player() != step.player {
            return Err(MISMATCH.into());
        }
        let (idx, used) = find(game, step.want).ok_or(MISMATCH)?;
        if let (Some(i), Some(u)) = (step.size, used)
            && let Some(s) = sizes.get_mut(i)
        {
            s.used = Some(u);
        }
        on_step(game, step.player, idx);
        game.play(idx);
    }
    Ok(())
}

/// Plays the whole plan from the root and checks that hero is to act.
pub fn walk(
    game: &mut PostFlopGame,
    plan: &StreetPlan,
    sizes: &mut [LineSize],
    on_step: impl FnMut(&mut PostFlopGame, usize, usize),
) -> Result<(), String> {
    game.back_to_root();
    play_steps(game, &plan.steps, sizes, on_step)?;
    if game.is_terminal_node() || game.is_chance_node() || game.current_player() != plan.hero {
        return Err(MISMATCH.into());
    }
    Ok(())
}

/// Labels for `NodeSummary::line` ("Check", "Bet", "Raise", "AllIn").
pub fn labels(steps: &[StreetStep]) -> Vec<String> {
    steps
        .iter()
        .map(|s| {
            match s.want {
                Want::Check => "Check",
                Want::Call => "Call",
                Want::Bet(_) => "Bet",
                Want::Raise(_) => "Raise",
                Want::AllIn => "AllIn",
            }
            .to_string()
        })
        .collect()
}

/// Lock strategy for the node about to play `action`: every hand of `player` takes it
/// (`full`), or only `hand` (index into `private_cards(player)`). Others stay free.
pub fn lock_row(game: &PostFlopGame, player: usize, action: usize, full: bool, hand: Option<usize>) -> Option<Vec<f32>> {
    let n = game.private_cards(player).len();
    let a = game.available_actions().len();
    let mut v = vec![0.0f32; n * a];
    if full {
        v[action * n..(action + 1) * n].fill(1.0);
    } else {
        v[action * n + hand?] = 1.0;
    }
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_board;
    use postflop_solver::{ActionTree, CardConfig};
    use serde_json::json;

    fn a(street: &str, player: &str, action: &str, amount: Option<i32>) -> Value {
        json!({"street": street, "player": player, "action": action, "amount_chips": amount})
    }

    fn opts(bet: &str, raise: &str) -> BetSizeOptions {
        BetSizeOptions::try_from((bet, raise)).unwrap()
    }

    fn tree(board: &str, bet: &str, raise: &str) -> TreeConfig {
        let (_, turn, river) = parse_board(board).unwrap();
        let o = opts(bet, raise);
        TreeConfig {
            initial_state: crate::config::board_state(turn, river),
            starting_pot: 550,
            effective_stack: 9750,
            flop_bet_sizes: [o.clone(), o.clone()],
            turn_bet_sizes: [o.clone(), o.clone()],
            river_bet_sizes: [o.clone(), o],
            add_allin_threshold: 1.5,
            force_allin_threshold: 0.15,
            merging_threshold: 0.1,
            ..TreeConfig::default()
        }
    }

    fn plan_of(line: &[Value], hero: PlayerSide, t: &mut TreeConfig) -> StreetStatus {
        plan(Some(line), Some(hero), t)
    }

    #[test]
    fn adds_the_bet_for_the_actor_only_and_a_raise_for_hero() {
        // Flop tree: one bet size, no raises. OOP leads 413 (75%), hero IP to act.
        let mut t = tree("Ks7d2c", "50%", "");
        let StreetStatus::Plan(p) = plan_of(&[a("flop", "oop", "bet", Some(413))], PlayerSide::Ip, &mut t) else {
            panic!()
        };
        assert_eq!(p.steps, vec![StreetStep { player: 0, want: Want::Bet(413), size: Some(0) }]);
        assert_eq!(p.sizes[0].size, "75%");
        assert!(p.sizes[0].added);
        assert_eq!(t.flop_bet_sizes[0], opts("50%, 75%", ""));
        // Hero's options are unchanged; a 3x and an all-in raise are added at the decision only.
        assert_eq!(t.flop_bet_sizes[1], opts("50%", ""));
        assert_eq!(
            p.extra_lines,
            vec![vec![Action::Bet(413), Action::Raise(1239)], vec![Action::Bet(413), Action::AllIn(9750)]]
        );
        // Later streets untouched; no merging.
        assert_eq!(t.turn_bet_sizes, [opts("50%", ""), opts("50%", "")]);
        assert_eq!(t.merging_threshold, 0.0);
    }

    #[test]
    fn default_sizes_are_not_added_and_checks_change_nothing() {
        let mut t = tree("Td9d6hQc", "33%, 75%", "3x");
        let before = t.clone();
        let StreetStatus::Plan(p) = plan_of(&[a("turn", "oop", "check", None)], PlayerSide::Ip, &mut t) else {
            panic!()
        };
        assert!(p.sizes.is_empty());
        assert_eq!(format!("{t:?}"), format!("{before:?}"));

        // IP bets 182 (33%) after a check, OOP (hero) faces it: no size added, hero has 3x
        // already, so only an all-in raise line is added for hero.
        let mut t = tree("Td9d6hQc", "33%, 75%", "3x");
        let before = t.clone();
        let line = [a("turn", "oop", "check", None), a("turn", "ip", "bet", Some(182))];
        let StreetStatus::Plan(p) = plan_of(&line, PlayerSide::Oop, &mut t) else { panic!() };
        assert!(!p.sizes[0].added);
        assert_eq!(format!("{t:?}"), format!("{before:?}"));
        assert_eq!(p.extra_lines, vec![vec![Action::Check, Action::Bet(182), Action::AllIn(9750)]]);
    }

    #[test]
    fn raises_and_allins_go_to_the_right_lists() {
        // Hero OOP bets 300, villain raises to 1050, hero to act.
        let mut t = tree("Td9d6hQc", "33%, 75%", "3x");
        let line = [a("turn", "oop", "bet", Some(300)), a("turn", "ip", "raise", Some(1050))];
        let StreetStatus::Plan(p) = plan_of(&line, PlayerSide::Oop, &mut t) else { panic!() };
        assert_eq!(p.sizes[0].size, "54.5%");
        assert_eq!(p.sizes[1].size, "3.5x");
        assert_eq!(p.sizes[1].action, "raise");
        assert_eq!(t.turn_bet_sizes[0].bet, opts("33%, 54.5%, 75%", "").bet);
        assert_eq!(t.turn_bet_sizes[1].raise, opts("", "3x, 3.5x").raise);
        // Hero (OOP) faces the raise and already has 3x: an all-in raise line.
        assert_eq!(t.turn_bet_sizes[0].raise, opts("", "3x").raise);
        assert_eq!(p.extra_lines, vec![vec![Action::Bet(300), Action::Raise(1050), Action::AllIn(9750)]]);

        // Villain shoves into hero: "a" for villain's bets; nothing added for hero.
        let mut t = tree("Td9d6h", "50%", "");
        let StreetStatus::Plan(p) = plan_of(&[a("flop", "oop", "allin", None)], PlayerSide::Ip, &mut t) else {
            panic!()
        };
        assert_eq!(p.steps[0].want, Want::AllIn);
        assert_eq!((p.sizes[0].action.as_str(), p.sizes[0].requested), ("allin", 9750));
        assert_eq!(t.flop_bet_sizes[0], opts("50%, a", ""));
        assert_eq!(t.flop_bet_sizes[1], opts("50%", ""));
        assert!(p.extra_lines.is_empty());
        // A bet of the whole stack is an all-in too.
        let mut t = tree("Td9d6h", "50%", "");
        let StreetStatus::Plan(p) = plan_of(&[a("flop", "oop", "bet", Some(20000))], PlayerSide::Ip, &mut t) else {
            panic!()
        };
        assert_eq!(p.steps[0].want, Want::AllIn);
    }

    #[test]
    fn unusable_actions_have_reasons_and_leave_the_tree_alone() {
        let cases: Vec<(Vec<Value>, PlayerSide, &str)> = vec![
            (vec![a("flop", "ip", "check", None)], PlayerSide::Ip, "out of turn"),
            (vec![a("flop", "oop", "check", None), a("flop", "ip", "check", None)], PlayerSide::Oop, "street is over"),
            (vec![a("flop", "oop", "bet", Some(300)), a("flop", "ip", "call", None)], PlayerSide::Oop, "call"),
            (vec![a("flop", "oop", "bet", Some(300)), a("flop", "ip", "fold", None)], PlayerSide::Oop, "fold"),
            (vec![a("flop", "oop", "bet", Some(300))], PlayerSide::Oop, "doesn't end with your decision"),
            (vec![a("turn", "oop", "bet", Some(300))], PlayerSide::Ip, "another street"),
            (vec![a("flop", "oop", "bet", None)], PlayerSide::Ip, "no usable amount"),
            (vec![a("flop", "oop", "bet", Some(300)), a("flop", "ip", "raise", Some(200))], PlayerSide::Oop, "isn't bigger"),
            (vec![json!({"street": "flop", "player": "hero"})], PlayerSide::Ip, "couldn't be read"),
        ];
        for (line, hero, want) in cases {
            let mut t = tree("Td9d6h", "50%", "");
            let before = format!("{t:?}");
            match plan_of(&line, hero, &mut t) {
                StreetStatus::Skip(r) => assert!(r.contains(want), "{want:?} not in {r:?}"),
                other => panic!("expected skip for {want:?}, got {other:?}"),
            }
            assert_eq!(format!("{t:?}"), before);
        }
        let mut t = tree("Td9d6h", "50%", "");
        assert!(matches!(plan(None, Some(PlayerSide::Ip), &mut t), StreetStatus::None));
        assert!(matches!(plan(Some(&[a("flop", "oop", "check", None)]), None, &mut t), StreetStatus::Skip(_)));
    }

    #[test]
    fn walks_to_the_facing_bet_node_with_the_exact_size() {
        let mut t = tree("Ks7d2c", "50%", "");
        let StreetStatus::Plan(p) = plan_of(&[a("flop", "oop", "bet", Some(413))], PlayerSide::Ip, &mut t) else {
            panic!()
        };
        let (flop, turn, river) = parse_board("Ks7d2c").unwrap();
        let card = CardConfig { range: ["QQ,77,AK".parse().unwrap(), "QQ,JJ,AK".parse().unwrap()], flop, turn, river };
        let mut tree = ActionTree::new(t).unwrap();
        for l in &p.extra_lines {
            tree.add_line(l).unwrap();
        }
        let mut game = PostFlopGame::with_config(card, tree).unwrap();
        game.allocate_memory(false);
        game.back_to_root();
        // OOP: check, the default 50% (275), the line's 413 kept next to it.
        assert_eq!(game.available_actions(), vec![Action::Check, Action::Bet(275), Action::Bet(413)]);
        let mut sizes = p.sizes.clone();
        walk(&mut game, &p, &mut sizes, |_, _, _| {}).unwrap();
        assert_eq!(sizes[0].used, Some(413));
        assert_eq!(game.current_player(), 1);
        assert_eq!(
            game.available_actions(),
            vec![Action::Fold, Action::Call, Action::Raise(1239), Action::AllIn(9750)]
        );
        // Facing the default 50% lead, hero has no raise: the lines were added here only.
        game.back_to_root();
        game.play(1);
        assert_eq!(game.available_actions(), vec![Action::Fold, Action::Call]);
    }
}
