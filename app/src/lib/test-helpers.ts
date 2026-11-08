import type { Extraction } from "./schema";

/** A minimal solvable extraction (flop board, everything else unstated). */
export function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    is_poker_spot: true,
    num_players: null,
    street: null,
    board: "Td9d6h",
    hero_position: null,
    villain_position: null,
    hero_hand: null,
    villain_hand: null,
    pot_type: null,
    pot_bb: null,
    effective_stack_bb: null,
    starting_stack_bb: null,
    amount_unit: null,
    big_blind_size: null,
    actions: null,
    oop_range: null,
    ip_range: null,
    bet_sizes: null,
    notes: null,
    ...overrides,
  };
}
