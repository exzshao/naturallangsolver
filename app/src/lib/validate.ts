// App-side validation (SPEC §6). Pure functions: cheap checks that run before
// any HTTP call. The solver re-checks authoritatively.
import type { ResolvedSpot } from "./defaults";
import { historyProblem } from "./history";
import { bbToChips, hasDuplicates, parseCards, parseHand, STREET_BY_CARD_COUNT } from "./poker";
import type { Extraction } from "./schema";
import type { CantSolveReason, CantSolveResponse } from "./types";
import { readVillainHand } from "./villain";

export const CANT_SOLVE_MESSAGES: Record<CantSolveReason, string> = {
  NOT_POKER: "Can't solve this: that doesn't look like a poker spot.",
  INVALID_REQUEST: "Can't solve this: the solver rejected the request as malformed.",
  PREFLOP: "Can't solve this: preflop spots aren't supported yet.",
  MULTIWAY: "Can't solve this: only heads-up spots are supported.",
  INVALID_BOARD: "Can't solve this: the board or hole cards aren't valid.",
  INVALID_RANGE: "Can't solve this: one of the ranges couldn't be used.",
  INVALID_BET_SIZES: "Can't solve this: the bet sizes couldn't be used.",
  INVALID_STACKS: "Can't solve this: the pot and stack sizes must be positive.",
  TREE_TOO_LARGE: "Can't solve this: the game tree is too large for the available memory.",
  TIMEOUT: "Can't solve this: the solve took too long.",
  SOLVER_BUSY: "Can't solve this: the solver queue is full or the wait timed out. Try again in a moment.",
  RATE_LIMITED: "Can't solve this: too many solves. Try again later.",
  LLM_UNAVAILABLE: "Can't solve this: the language model is unavailable right now.",
  SOLVER_UNAVAILABLE: "Can't solve this: the solver is unavailable right now.",
  INTERNAL: "Can't solve this: something went wrong.",
};

export function cantSolve(reason: CantSolveReason, message = CANT_SOLVE_MESSAGES[reason]): CantSolveResponse {
  return { status: "cant_solve", reason, message };
}

/**
 * Checks on the raw extraction, before defaults. Returns null when the spot
 * can proceed to applyDefaults(). Order matters: NOT_POKER, PREFLOP,
 * MULTIWAY, INVALID_BOARD, INVALID_STACKS (incl. inconsistent action amounts).
 */
export function validateExtraction(x: Extraction): CantSolveResponse | null {
  if (!x.is_poker_spot) return cantSolve("NOT_POKER");
  if (x.street === "preflop" || !x.board || x.board.trim() === "") return cantSolve("PREFLOP");
  if (x.num_players !== null && x.num_players !== 2) return cantSolve("MULTIWAY");

  const board = parseCards(x.board);
  if (!board || !(board.length in STREET_BY_CARD_COUNT) || hasDuplicates(board)) {
    return cantSolve("INVALID_BOARD");
  }
  if (x.street !== null && STREET_BY_CARD_COUNT[board.length] !== x.street) {
    return cantSolve("INVALID_BOARD");
  }
  // A malformed hero_hand is dropped by applyDefaults; a valid one must not
  // overlap the board.
  const hand = x.hero_hand ? parseHand(x.hero_hand) : null;
  if (hand && parseCards(hand)!.some((c) => board.includes(c))) {
    return cantSolve("INVALID_BOARD");
  }

  // A readable villain hand must leave a combo after the board and hero's cards.
  const villain = x.villain_hand ? readVillainHand(x.villain_hand, [...board, ...(hand ? parseCards(hand)! : [])]) : null;
  if (villain && villain.combos === 0) {
    return cantSolve(
      "INVALID_BOARD",
      `Can't solve this: villain's ${villain.label} overlaps the board or your hand.`,
    );
  }

  for (const v of [x.pot_bb, x.effective_stack_bb, x.starting_stack_bb]) {
    if (v !== null && !(v > 0)) return cantSolve("INVALID_STACKS");
  }
  const problem = historyProblem(x);
  if (problem) return cantSolve("INVALID_STACKS", `Can't solve this: the bet amounts don't add up (${problem}).`);
  return null;
}

/** Checks on the fully defaulted spot (e.g. a derived stack that went non-positive). */
export function validateSpot(spot: ResolvedSpot): CantSolveResponse | null {
  if (bbToChips(spot.potBb) <= 0) return cantSolve("INVALID_STACKS");
  if (bbToChips(spot.effectiveStackBb) <= 0) {
    return cantSolve(
      "INVALID_STACKS",
      "Can't solve this: the bets add up to more than the stacks, so there's nothing left to play for. Tell me the stack sizes if they were deeper.",
    );
  }
  return null;
}
