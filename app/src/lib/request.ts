// Maps a defaulted spot to the solver request body (SPEC §7), and chains the
// pure steps: validate extraction -> apply defaults -> validate spot -> build.
import { applyDefaults, type ResolvedSpot } from "./defaults";
import { NO_LINE_ASSUMPTION, POT_TOO_SMALL_NO_LINE, toSolverLine, USER_RANGES_NO_LINE } from "./line";
import { bbToChips, parseCards } from "./poker";
import type { Extraction } from "./schema";
import { currentStreetLine, type StreetLine, toSolverStreetActions } from "./street";
import type { CantSolveResponse, SolverRequest } from "./types";
import { validateExtraction, validateSpot } from "./validate";
import { readVillainHand, type VillainHand } from "./villain";

/** What the spot carries beyond the defaulted fields: current-street action, villain's known hand. */
export type SpotExtras = { street: StreetLine | null; villainHand: VillainHand | null };

export function buildSolverRequest(spot: ResolvedSpot, extras?: Partial<SpotExtras>): SolverRequest {
  const line = spot.line
    ? {
        line: toSolverLine(spot.line, spot.heroPlayer),
        flop_pot: bbToChips(spot.line.flopPotBb),
        flop_stack: bbToChips(spot.line.flopStackBb),
      }
    : {};
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
    ...line,
    ...(extras?.street ? { street_actions: toSolverStreetActions(extras.street, spot.heroPlayer) } : {}),
    ...(extras?.villainHand ? { villain_hand: extras.villainHand.label } : {}),
    ...(spot.preflopAggressor ? { preflop_aggressor: spot.preflopAggressor } : {}),
    ...(spot.betSizeFallbacks.length ? { bet_size_fallbacks: spot.betSizeFallbacks } : {}),
  };
}

export const villainKnownAssumption = (label: string) =>
  `Villain's hand known: ${label} — strategy is exact against that hand.`;

/**
 * Known villain hand: villain's range becomes exactly those combos, and the earlier-street
 * narrowing is skipped (nothing to narrow). Precondition: validateExtraction passed.
 */
export function applyVillainHand(
  x: Pick<Extraction, "villain_hand">,
  spot: ResolvedSpot,
  assumptions: string[],
): { spot: ResolvedSpot; assumptions: string[]; villainHand: VillainHand | null } {
  if (!x.villain_hand) return { spot, assumptions, villainHand: null };
  const dead = [...(parseCards(spot.board) ?? []), ...(spot.heroHand ? (parseCards(spot.heroHand) ?? []) : [])];
  const v = readVillainHand(x.villain_hand, dead);
  if (!v || v.combos === 0) {
    return {
      spot,
      assumptions: [...assumptions, `Ignored villain hand "${x.villain_hand}" (needs two exact cards like 7c2d or a hand class like 72o)`],
      villainHand: null,
    };
  }
  const villainSeat = spot.heroPlayer === "oop" ? "ipRange" : "oopRange";
  const skipped = new Set([NO_LINE_ASSUMPTION, USER_RANGES_NO_LINE, POT_TOO_SMALL_NO_LINE]);
  return {
    spot: { ...spot, [villainSeat]: v.range, line: null },
    assumptions: [...assumptions.filter((a) => !skipped.has(a)), villainKnownAssumption(v.label)],
    villainHand: v,
  };
}

export type PrepareResult =
  | ({ ok: true; request: SolverRequest; spot: ResolvedSpot; assumptions: string[] } & SpotExtras)
  | { ok: false; error: CantSolveResponse };

export function prepareSolve(extraction: Extraction): PrepareResult {
  const early = validateExtraction(extraction);
  if (early) return { ok: false, error: early };
  const defaulted = applyDefaults(extraction);
  const late = validateSpot(defaulted.spot);
  if (late) return { ok: false, error: late };
  const { spot, assumptions, villainHand } = applyVillainHand(extraction, defaulted.spot, defaulted.assumptions);
  const { line: street, assumptions: streetNotes } = currentStreetLine(extraction, spot);
  return {
    ok: true,
    request: buildSolverRequest(spot, { street, villainHand }),
    spot,
    assumptions: [...assumptions, ...streetNotes],
    street,
    villainHand,
  };
}
