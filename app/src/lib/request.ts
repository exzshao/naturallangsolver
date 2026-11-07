// Maps a defaulted spot to the solver request body (SPEC §7), and chains the
// pure steps: validate extraction -> apply defaults -> validate spot -> build.
import { applyDefaults, type ResolvedSpot } from "./defaults";
import { bbToChips } from "./poker";
import type { Extraction } from "./schema";
import type { CantSolveResponse, SolverRequest } from "./types";
import { validateExtraction, validateSpot } from "./validate";

export function buildSolverRequest(spot: ResolvedSpot): SolverRequest {
  return {
    board: spot.board,
    oop_range: spot.oopRange,
    ip_range: spot.ipRange,
    starting_pot: bbToChips(spot.potBb),
    effective_stack: bbToChips(spot.effectiveStackBb),
    bet_sizes: spot.betSizes,
    hero: { player: spot.heroPlayer, hand: spot.heroHand },
    max_iterations: spot.maxIterations,
    target_exploitability_pct: spot.targetExploitabilityPct,
  };
}

export type PrepareResult =
  | { ok: true; request: SolverRequest; spot: ResolvedSpot; assumptions: string[] }
  | { ok: false; error: CantSolveResponse };

export function prepareSolve(extraction: Extraction): PrepareResult {
  const early = validateExtraction(extraction);
  if (early) return { ok: false, error: early };
  const { spot, assumptions } = applyDefaults(extraction);
  const late = validateSpot(spot);
  if (late) return { ok: false, error: late };
  return { ok: true, request: buildSolverRequest(spot), spot, assumptions };
}
