use pyo3::prelude::*;
use postflop_solver::*;

#[pyclass]
struct PostFlopSolver {
    game: PostFlopGame,
}

#[pymethods]
impl PostFlopSolver {
    #[new]
    #[pyo3(signature = (
        oop_range, 
        ip_range, 
        flop, 
        starting_pot, 
        effective_stack, 
        bet_sizes="60%, e, a",
        raise_sizes="2.5x",
        turn=None, 
        river=None,
        rake_rate=0.0,
        rake_cap=0.0,
        flop_bet_sizes_oop=None,
        flop_bet_sizes_ip=None,
        turn_bet_sizes_oop=None,
        turn_bet_sizes_ip=None,
        river_bet_sizes_oop=None,
        river_bet_sizes_ip=None,
        turn_donk_sizes=None,
        river_donk_sizes=None,
        add_allin_threshold=1.5,
        force_allin_threshold=0.15,
        merging_threshold=0.1,
    ))]
    fn new(
        oop_range: &str,
        ip_range: &str,
        flop: &str,
        starting_pot: i32,
        effective_stack: i32,
        bet_sizes: &str,
        raise_sizes: &str,
        turn: Option<&str>,
        river: Option<&str>,
        rake_rate: f64,
        rake_cap: f64,
        flop_bet_sizes_oop: Option<(&str, &str)>,
        flop_bet_sizes_ip: Option<(&str, &str)>,
        turn_bet_sizes_oop: Option<(&str, &str)>,
        turn_bet_sizes_ip: Option<(&str, &str)>,
        river_bet_sizes_oop: Option<(&str, &str)>,
        river_bet_sizes_ip: Option<(&str, &str)>,
        turn_donk_sizes: Option<&str>,
        river_donk_sizes: Option<&str>,
        add_allin_threshold: f64,
        force_allin_threshold: f64,
        merging_threshold: f64,
    ) -> PyResult<Self> {
        // Parse ranges
        let oop_range = oop_range.parse()
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid OOP range: {}", e)))?;
        let ip_range = ip_range.parse()
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid IP range: {}", e)))?;

        // Parse flop
        let flop = flop_from_str(flop)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid flop: {}", e)))?;

        // Parse turn
        let turn = if let Some(turn_str) = turn {
            card_from_str(turn_str)
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid turn: {}", e)))?
        } else {
            NOT_DEALT
        };

        // Parse river
        let river = if let Some(river_str) = river {
            card_from_str(river_str)
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid river: {}", e)))?
        } else {
            NOT_DEALT
        };

        let card_config = CardConfig {
            range: [oop_range, ip_range],
            flop,
            turn,
            river,
        };

        // Parse default bet sizes (used if street-specific sizes not provided)
        let default_bet_sizes = BetSizeOptions::try_from((bet_sizes, raise_sizes))
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid bet sizes: {}", e)))?;

        // Parse per-street, per-player bet sizes (or use defaults)
        let flop_sizes_oop = if let Some((bet, raise)) = flop_bet_sizes_oop {
            BetSizeOptions::try_from((bet, raise))
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid flop OOP sizes: {}", e)))?
        } else {
            default_bet_sizes.clone()
        };

        let flop_sizes_ip = if let Some((bet, raise)) = flop_bet_sizes_ip {
            BetSizeOptions::try_from((bet, raise))
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid flop IP sizes: {}", e)))?
        } else {
            default_bet_sizes.clone()
        };

        let turn_sizes_oop = if let Some((bet, raise)) = turn_bet_sizes_oop {
            BetSizeOptions::try_from((bet, raise))
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid turn OOP sizes: {}", e)))?
        } else {
            default_bet_sizes.clone()
        };

        let turn_sizes_ip = if let Some((bet, raise)) = turn_bet_sizes_ip {
            BetSizeOptions::try_from((bet, raise))
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid turn IP sizes: {}", e)))?
        } else {
            default_bet_sizes.clone()
        };

        let river_sizes_oop = if let Some((bet, raise)) = river_bet_sizes_oop {
            BetSizeOptions::try_from((bet, raise))
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid river OOP sizes: {}", e)))?
        } else {
            default_bet_sizes.clone()
        };

        let river_sizes_ip = if let Some((bet, raise)) = river_bet_sizes_ip {
            BetSizeOptions::try_from((bet, raise))
                .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid river IP sizes: {}", e)))?
        } else {
            default_bet_sizes.clone()
        };

        // Parse donk sizes
        let turn_donk = turn_donk_sizes
            .map(|s| DonkSizeOptions::try_from(s))
            .transpose()
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid turn donk sizes: {}", e)))?;

        let river_donk = river_donk_sizes
            .map(|s| DonkSizeOptions::try_from(s))
            .transpose()
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Invalid river donk sizes: {}", e)))?;

        let initial_state = if river != NOT_DEALT {
            BoardState::River
        } else if turn != NOT_DEALT {
            BoardState::Turn
        } else {
            BoardState::Flop
        };

        let tree_config = TreeConfig {
            initial_state,
            starting_pot,
            effective_stack,
            rake_rate,
            rake_cap,
            flop_bet_sizes: [flop_sizes_oop, flop_sizes_ip],
            turn_bet_sizes: [turn_sizes_oop, turn_sizes_ip],
            river_bet_sizes: [river_sizes_oop, river_sizes_ip],
            turn_donk_sizes: turn_donk,
            river_donk_sizes: river_donk,
            add_allin_threshold,
            force_allin_threshold,
            merging_threshold,
        };

        let action_tree = ActionTree::new(tree_config)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("{}", e)))?;

        let game = PostFlopGame::with_config(card_config, action_tree)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("{}", e)))?;

        Ok(PostFlopSolver { game })
    }

    #[pyo3(signature = (max_iterations, target_exploitability, enable_compression=false))]
    fn solve(&mut self, max_iterations: u32, target_exploitability: f32, enable_compression: bool) -> PyResult<f32> {
        self.game.allocate_memory(enable_compression);
        Ok(solve(&mut self.game, max_iterations, target_exploitability, true))
    }

    fn get_private_cards(&self, player: usize) -> PyResult<Vec<String>> {
        let cards = self.game.private_cards(player);
        holes_to_strings(&cards)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Failed to convert cards: {}", e)))
    }

    fn get_equity(&mut self, player: usize) -> PyResult<Vec<f32>> {
        self.game.cache_normalized_weights();
        Ok(self.game.equity(player).to_vec())
    }

    fn get_strategy(&self) -> PyResult<Vec<f32>> {
        Ok(self.game.strategy().to_vec())
    }

    fn get_available_actions(&self) -> PyResult<Vec<String>> {
        Ok(self.game.available_actions()
            .iter()
            .map(|action| format!("{:?}", action))
            .collect())
    }

    fn play(&mut self, action_index: usize) -> PyResult<()> {
        self.game.play(action_index);
        Ok(())
    }

    fn back_to_root(&mut self) -> PyResult<()> {
        self.game.back_to_root();
        Ok(())
    }

    fn get_action_frequencies(&mut self) -> PyResult<Vec<(String, f32)>> {
        let actions = self.game.available_actions();
        let strategy = self.game.strategy();
        let num_hands = self.game.private_cards(0).len();
        
        if actions.is_empty() {
            return Ok(vec![]);
        }

        self.game.cache_normalized_weights();
        
        let mut frequencies = vec![0.0; actions.len()];
        let weights = self.game.normalized_weights(0);

        // Calculate weighted frequencies
        for hand_idx in 0..num_hands {
            for (action_idx, frequency) in frequencies.iter_mut().enumerate() {
                let strategy_idx = action_idx * num_hands + hand_idx;
                *frequency += strategy[strategy_idx] * weights[hand_idx];
            }
        }

        // Normalize frequencies to sum to 1.0
        let total: f32 = frequencies.iter().sum();
        if total > 0.0 {
            for freq in frequencies.iter_mut() {
                *freq /= total;
            }
        }

        // Convert to percentages and return
        Ok(actions.iter()
            .zip(frequencies.iter())
            .map(|(action, &freq)| (format!("{:?}", action), freq))
            .collect())
    }

    fn get_hand_frequencies(&self, hand_index: usize) -> PyResult<Vec<(String, f32)>> {
        let actions = self.game.available_actions();
        let strategy = self.game.strategy();
        let num_hands = self.game.private_cards(0).len();
        
        if hand_index >= num_hands {
            return Err(PyErr::new::<pyo3::exceptions::PyValueError, _>(
                format!("Hand index {} is out of range (max: {})", hand_index, num_hands - 1)
            ));
        }

        // Get frequencies for this specific hand
        let frequencies: Vec<(String, f32)> = actions.iter()
            .enumerate()
            .map(|(action_idx, action)| {
                let strategy_idx = action_idx * num_hands + hand_index;
                (format!("{:?}", action), strategy[strategy_idx])
            })
            .collect();

        Ok(frequencies)
    }

    /// Get frequencies for all hands with their corresponding cards
    fn get_all_hand_frequencies(&self) -> PyResult<Vec<(String, Vec<(String, f32)>)>> {
        let hands = holes_to_strings(&self.game.private_cards(0))
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(format!("Failed to convert cards: {}", e)))?;
        
        let mut result = Vec::new();
        
        for (i, hand) in hands.iter().enumerate() {
            let frequencies = self.get_hand_frequencies(i)?;
            result.push((hand.clone(), frequencies));
        }

        Ok(result)
    }

    fn cache_normalized_weights(&mut self) -> PyResult<()> {
        self.game.cache_normalized_weights();
        Ok(())
    }

    /// Get normalized weights for player
    fn get_normalized_weights(&self, player: usize) -> PyResult<Vec<f32>> {
        Ok(self.game.normalized_weights(player).to_vec())
    }
}

#[pymodule]
fn postflop_solver_python(_py: Python<'_>, m: &PyModule) -> PyResult<()> {
    m.add_class::<PostFlopSolver>()?;
    Ok(())
}