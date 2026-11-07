//! Pre-flight tree size estimate, run before anything large is allocated (SPEC §8).
//!
//! `PostFlopGame::with_config` allocates one `PostFlopNode` per action-tree node per
//! runout *before* `memory_usage()` can be asked, so a big flop tree (say 7 bet sizes and
//! 3 raise sizes at 200bb: ~660k river action nodes x ~2,000 runouts x 64 B) gets the
//! process OOM-killed instead of returning `TREE_TOO_LARGE`. `ActionTree::new` itself
//! has no size limit either.
//!
//! [`estimate`] walks the same tree `ActionTree::new` would build, without allocating
//! it, and stops as soon as the running byte estimate passes the budget. It mirrors the
//! crate's `build_tree_recursive` / `push_actions` / `BuildTreeInfo::create_next` /
//! `merge_bet_actions` (postflop-solver rev 9d1509f); a test checks it node-for-node
//! against the real `ActionTree`.

use postflop_solver::{Action, BetSize, BoardState, PostFlopNode, TreeConfig};

const PLAYER_OOP: u8 = 0;
const PLAYER_CHANCE: u8 = 2;
const PLAYER_CHANCE_FLAG: u8 = 4;
const PLAYER_TERMINAL_FLAG: u8 = 8;
const PLAYER_FOLD_FLAG: u8 = 24;

/// Heap bytes per `ActionTree` node. Measured 105-110 B/node (RSS after
/// `ActionTree::new` on 0.7M-3.4M node trees, macOS arm64), rounded up.
pub const ACTION_TREE_NODE_BYTES: u64 = 128;

/// Lines deeper than this are treated as too large. Real trees stay well under 100
/// (a 2x raise war at 50,000bb is ~20 deep per street); this only stops tiny
/// constant-chip sizes at huge stacks from overflowing the stack while recursing.
const MAX_DEPTH: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Estimate {
    /// Action-tree nodes per street (flop, turn, river), counted until the walk stopped.
    pub action_nodes: [u64; 3],
    /// Upper bound on bytes for the `ActionTree` plus the game's node arena, counted
    /// until the walk stopped.
    pub bytes: u64,
    /// True if the walk stopped early because `bytes` passed the budget (or a line got
    /// deeper than `MAX_DEPTH`).
    pub exceeded: bool,
}

/// Estimates the memory that `ActionTree::new` + `PostFlopGame::with_config` will
/// allocate for `config`, stopping once it passes `budget` bytes.
///
/// The arena part assumes every undealt card is a separate runout (49 turns, 49x48
/// rivers from a flop; the crate's suit isomorphism can only lower that), so the
/// estimate never undercounts. It excludes the solver storage that `memory_usage()`
/// reports, which is usually 100x larger than the arena and is still checked after
/// the game is built.
///
/// Returns `None` for configs with donk sizes, which the mirror doesn't model.
pub fn estimate(config: &TreeConfig, budget: u64) -> Option<Estimate> {
    estimate_with(config, budget, |_, _| {})
}

/// Like [`estimate`], calling `on_decision(depth, actions)` at every player node in
/// depth-first order (tests compare this with the real `ActionTree`).
fn estimate_with(
    config: &TreeConfig,
    budget: u64,
    on_decision: impl FnMut(usize, &[Action]),
) -> Option<Estimate> {
    if config.turn_donk_sizes.is_some() || config.river_donk_sizes.is_some() {
        return None;
    }
    // Runouts per action node on each street, given the starting street.
    let runouts: [u64; 3] = match config.initial_state {
        BoardState::Flop => [1, 49, 49 * 48],
        BoardState::Turn => [0, 1, 48],
        BoardState::River => [0, 0, 1],
    };
    let arena_node = std::mem::size_of::<PostFlopNode>() as u64;
    let mut w = Walker {
        cfg: config,
        weight: runouts.map(|r| ACTION_TREE_NODE_BYTES + r * arena_node),
        budget,
        bytes: 0,
        nodes: [0; 3],
        on_decision,
    };
    let ok = w.walk(PLAYER_OOP, config.initial_state, 0, Info::new(config.effective_stack), 0);
    Some(Estimate { action_nodes: w.nodes, bytes: w.bytes, exceeded: !ok })
}

#[derive(Clone, Copy)]
struct Info {
    prev_action: Action,
    num_bets: i32,
    allin_flag: bool,
    stack: [i32; 2],
    prev_amount: i32,
}

impl Info {
    fn new(stack: i32) -> Self {
        Self { prev_action: Action::None, num_bets: 0, allin_flag: false, stack: [stack, stack], prev_amount: 0 }
    }

    fn next(&self, player: u8, action: Action) -> Self {
        let mut n = *self;
        n.prev_action = action;
        let p = player as usize;
        match action {
            Action::Call => {
                n.num_bets = 0;
                n.stack[p] = n.stack[p ^ 1];
                n.prev_amount = 0;
            }
            Action::Bet(amount) | Action::Raise(amount) | Action::AllIn(amount) => {
                let to_call = n.stack[p] - n.stack[p ^ 1];
                n.num_bets += 1;
                n.allin_flag = matches!(action, Action::AllIn(_));
                n.stack[p] -= amount - self.prev_amount + to_call;
                n.prev_amount = amount;
            }
            _ => {}
        }
        n
    }
}

struct Walker<'a, F> {
    cfg: &'a TreeConfig,
    weight: [u64; 3],
    budget: u64,
    bytes: u64,
    nodes: [u64; 3],
    on_decision: F,
}

impl<F: FnMut(usize, &[Action])> Walker<'_, F> {
    /// Returns false once the budget or depth limit is passed.
    fn walk(&mut self, player: u8, state: BoardState, amount: i32, info: Info, depth: usize) -> bool {
        let s = state as usize;
        self.nodes[s] += 1;
        self.bytes += self.weight[s];
        if self.bytes > self.budget || depth > MAX_DEPTH {
            return false;
        }
        if player & PLAYER_TERMINAL_FLAG != 0 {
            return true;
        }
        if player & PLAYER_CHANCE_FLAG != 0 {
            let next_state = match state {
                BoardState::Flop => BoardState::Turn,
                _ => BoardState::River,
            };
            let next_player = match (info.allin_flag, state) {
                (false, _) => PLAYER_OOP,
                (true, BoardState::Flop) => PLAYER_CHANCE_FLAG | PLAYER_CHANCE,
                (true, _) => PLAYER_TERMINAL_FLAG,
            };
            return self.walk(next_player, next_state, amount, info.next(0, Action::Chance(0)), depth);
        }

        let actions = self.actions(player, state, amount, &info);
        (self.on_decision)(depth, &actions);

        let opponent = player ^ 1;
        let to_call = info.stack[player as usize] - info.stack[opponent as usize];
        let after_call = match state {
            BoardState::River => PLAYER_TERMINAL_FLAG,
            _ => PLAYER_CHANCE_FLAG | player,
        };
        let after_check = if player == PLAYER_OOP { opponent } else { after_call };
        for action in actions {
            let (next_player, next_amount) = match action {
                Action::Fold => (PLAYER_FOLD_FLAG | player, amount),
                Action::Check => (after_check, amount),
                Action::Call => (after_call, amount + to_call),
                _ => (opponent, amount + to_call),
            };
            if !self.walk(next_player, state, next_amount, info.next(player, action), depth + 1) {
                return false;
            }
        }
        true
    }

    /// Mirror of `ActionTree::push_actions` (non-donk branch).
    fn actions(&self, player: u8, state: BoardState, node_amount: i32, info: &Info) -> Vec<Action> {
        let cfg = self.cfg;
        let player_stack = info.stack[player as usize];
        let opponent_stack = info.stack[player as usize ^ 1];
        let prev_amount = info.prev_amount;
        let to_call = player_stack - opponent_stack;

        let pot = cfg.starting_pot + 2 * (node_amount + to_call);
        let max_amount = opponent_stack + prev_amount;
        let min_amount = (prev_amount + to_call).clamp(1, max_amount);

        let spr_after_call = opponent_stack as f64 / pot as f64;
        let geometric = |num_streets: i32, max_ratio: f64| {
            let ratio = ((2.0 * spr_after_call + 1.0).powf(1.0 / num_streets as f64) - 1.0) / 2.0;
            (pot as f64 * ratio.min(max_ratio)).round() as i32
        };

        let (options, remaining_streets) = match state {
            BoardState::Flop => (&cfg.flop_bet_sizes[player as usize], 3),
            BoardState::Turn => (&cfg.turn_bet_sizes[player as usize], 2),
            BoardState::River => (&cfg.river_bet_sizes[player as usize], 1),
        };

        let mut actions = Vec::new();
        if matches!(info.prev_action, Action::None | Action::Check | Action::Chance(_)) {
            actions.push(Action::Check);
            for &size in &options.bet {
                match size {
                    BetSize::PotRelative(r) => actions.push(Action::Bet((pot as f64 * r).round() as i32)),
                    // `BetSizeOptions` rejects these for bets; the crate would panic.
                    BetSize::PrevBetRelative(_) => {}
                    BetSize::Additive(adder, _) => actions.push(Action::Bet(adder)),
                    BetSize::Geometric(n, max_ratio) => {
                        let n = if n == 0 { remaining_streets } else { n };
                        actions.push(Action::Bet(geometric(n, max_ratio)));
                    }
                    BetSize::AllIn => actions.push(Action::AllIn(max_amount)),
                }
            }
            if max_amount <= (pot as f64 * cfg.add_allin_threshold).round() as i32 {
                actions.push(Action::AllIn(max_amount));
            }
        } else {
            actions.push(Action::Fold);
            actions.push(Action::Call);
            if !info.allin_flag {
                for &size in &options.raise {
                    match size {
                        BetSize::PotRelative(r) => {
                            actions.push(Action::Raise(prev_amount + (pot as f64 * r).round() as i32))
                        }
                        BetSize::PrevBetRelative(r) => {
                            actions.push(Action::Raise((prev_amount as f64 * r).round() as i32))
                        }
                        BetSize::Additive(adder, cap) => {
                            if cap == 0 || info.num_bets <= cap {
                                actions.push(Action::Raise(prev_amount + adder));
                            }
                        }
                        BetSize::Geometric(n, max_ratio) => {
                            let base = if n == 0 { remaining_streets } else { n };
                            let n = i32::max(base - info.num_bets + 1, 1);
                            actions.push(Action::Raise(prev_amount + geometric(n, max_ratio)));
                        }
                        BetSize::AllIn => actions.push(Action::AllIn(max_amount)),
                    }
                }
                let threshold = pot as f64 * cfg.add_allin_threshold;
                if max_amount <= prev_amount + threshold.round() as i32 {
                    actions.push(Action::AllIn(max_amount));
                }
            }
        }

        let is_above_threshold = |amount: i32| {
            let new_pot = pot + 2 * (amount - prev_amount);
            let threshold = (new_pot as f64 * cfg.force_allin_threshold).round() as i32;
            max_amount <= amount + threshold
        };
        for action in actions.iter_mut() {
            let (amount, make): (i32, fn(i32) -> Action) = match *action {
                Action::Bet(a) => (a, Action::Bet),
                Action::Raise(a) => (a, Action::Raise),
                _ => continue,
            };
            let clamped = amount.clamp(min_amount, max_amount);
            if is_above_threshold(clamped) {
                *action = Action::AllIn(max_amount);
            } else if clamped != amount {
                *action = make(clamped);
            }
        }

        actions.sort_unstable();
        actions.dedup();
        merge_bet_actions(actions, pot, prev_amount, cfg.merging_threshold)
    }
}

/// Mirror of the crate's `merge_bet_actions`.
fn merge_bet_actions(actions: Vec<Action>, pot: i32, offset: i32, param: f64) -> Vec<Action> {
    const EPS: f64 = 1e-12;
    let amount_of = |action: Action| match action {
        Action::Bet(a) | Action::Raise(a) | Action::AllIn(a) => a,
        _ => -1,
    };
    let mut cur_amount = i32::MAX;
    let mut ret = Vec::new();
    for &action in actions.iter().rev() {
        let amount = amount_of(action);
        if amount > 0 {
            let ratio = (amount - offset) as f64 / pot as f64;
            let cur_ratio = (cur_amount - offset) as f64 / pot as f64;
            let threshold_ratio = (cur_ratio - param) / (1.0 + param);
            if ratio < threshold_ratio * (1.0 - EPS) {
                ret.push(action);
                cur_amount = amount;
            }
        } else {
            ret.push(action);
        }
    }
    ret.reverse();
    ret
}

#[cfg(test)]
mod tests {
    use super::*;
    use postflop_solver::{ActionTree, BetSizeOptions};

    /// (bet, raise) strings for flop, turn, river.
    type Sizes<'a> = [(&'a str, &'a str); 3];

    fn config(state: BoardState, stack: i32, sizes: Sizes) -> TreeConfig {
        let opt = |(b, r): (&str, &str)| {
            let o = BetSizeOptions::try_from((b, r)).unwrap();
            [o.clone(), o]
        };
        TreeConfig {
            initial_state: state,
            starting_pot: 550,
            effective_stack: stack,
            rake_rate: 0.0,
            rake_cap: 0.0,
            flop_bet_sizes: opt(sizes[0]),
            turn_bet_sizes: opt(sizes[1]),
            river_bet_sizes: opt(sizes[2]),
            turn_donk_sizes: None,
            river_donk_sizes: None,
            add_allin_threshold: 1.5,
            force_allin_threshold: 0.15,
            merging_threshold: 0.1,
        }
    }

    /// Depth-first (depth, actions) at every player node of the real tree, via the
    /// public history API.
    fn real_decisions(tree: &mut ActionTree, depth: usize, out: &mut Vec<(usize, Vec<Action>)>) {
        if tree.is_terminal_node() {
            return;
        }
        let actions = tree.available_actions().to_vec();
        out.push((depth, actions.clone()));
        for a in actions {
            tree.play(a).unwrap();
            real_decisions(tree, depth + 1, out);
            tree.undo().unwrap();
        }
    }

    #[test]
    fn mirrors_real_action_tree() {
        use BoardState::*;
        let cases: &[(BoardState, i32, Sizes)] = &[
            (Flop, 9750, [("33%, 75%", "3x"), ("33%, 75%", "3x"), ("33%, 75%, a", "3x")]),
            (Flop, 9750, [("50%", ""), ("75%", ""), ("75%", "")]),
            (Flop, 19750, [("25%, 50%, 100%", "2.5x, 60%"), ("e, 150%", "2e, a"), ("3e50%, 200c", "100c3r, 2x")]),
            (Flop, 1000, [("33%, 75%", "3x"), ("50%", "3x"), ("a", "")]),
            (Turn, 49750, [("", ""), ("25%, 33%, 50%, 75%, 100%, 125%, 150%", "2x, 3x, 4x"), ("50%, 100%", "3x")]),
            (River, 9750, [("", ""), ("", ""), ("10%, 25%, 33%, 50%, 75%, 100%, 150%, 200%, a", "2x, 50%, a")]),
            (River, 300, [("", ""), ("", ""), ("33%, 75%", "3x")]),
        ];
        for (state, stack, sizes) in cases {
            let cfg = config(*state, *stack, *sizes);
            let mut mine = Vec::new();
            let est = estimate_with(&cfg, u64::MAX, |d, a| mine.push((d, a.to_vec()))).unwrap();
            assert!(!est.exceeded);
            let mut real = Vec::new();
            real_decisions(&mut ActionTree::new(cfg).unwrap(), 0, &mut real);
            assert_eq!(mine.len(), real.len(), "{state:?} {stack} {sizes:?}");
            assert!(mine == real, "{state:?} {stack} {sizes:?}: action lists differ");
        }
    }

    #[test]
    fn counts_match_measured_trees() {
        let cfg = config(BoardState::Flop, 9750, [("33%, 75%", "3x"), ("33%, 75%", "3x"), ("33%, 75%, a", "3x")]);
        let est = estimate(&cfg, u64::MAX).unwrap();
        assert!(est.action_nodes[2] > est.action_nodes[1] && est.action_nodes[1] > est.action_nodes[0]);
        // Arena upper bound for the full default flop tree is ~0.5 GB (plus storage, ~20 GB).
        assert!(est.bytes > 400 << 20 && est.bytes < 700 << 20, "{est:?}");
    }

    #[test]
    fn stops_early_on_huge_flop_tree() {
        let s7 = ("25%, 33%, 50%, 75%, 100%, 125%, 150%", "2x, 3x, 4x");
        let cfg = config(BoardState::Flop, 19750, [s7, s7, s7]);
        let est = estimate(&cfg, 1024 << 20).unwrap();
        assert!(est.exceeded);
        // Stopped after a few thousand river nodes, not the full ~660k.
        assert!(est.action_nodes[2] < 10_000, "{est:?}");
    }

    #[test]
    fn small_spots_fit() {
        let small = config(BoardState::Flop, 9750, [("50%", ""), ("75%", ""), ("75%", "")]);
        let est = estimate(&small, 1024 << 20).unwrap();
        assert!(!est.exceeded && est.bytes < 50 << 20, "{est:?}");
        let river = config(BoardState::River, 9750, [("", ""), ("", ""), ("33%, 75%, a", "3x")]);
        assert!(!estimate(&river, 1 << 20).unwrap().exceeded);
    }
}
