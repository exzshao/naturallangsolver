// Default preflop ranges (SPEC §5): a position-aware table for 100bb, with a
// generic pair per pot type for the lines the table doesn't cover (cold
// 4-bets, squeezes, limped pots outside SB vs BB).
import type { Position, PotType } from "../schema";
import { PREFLOP_100BB, PREFLOP_SIZES_100BB } from "./preflop-100bb";

export type RangePair = { ip: string; oop: string };
/** Raise-to sizes in bb (blinds included) behind a seat pair's lines. */
export type LineSizes = { open: number; threeBet: number; fourBet: number };

export { PREFLOP_100BB, PREFLOP_SIZES_100BB };

/** Preflop action order. The earlier seat of a pair is the opener (or limper). */
export const PREFLOP_ORDER: readonly Position[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

export const GENERIC_RANGES: Readonly<Record<PotType, RangePair>> = {
  srp: {
    ip: "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o",
    oop: "JJ-22,AJs-A2s,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,75s+,64s+,53s+,AJo-A2o,K9o+,Q9o+,J9o+,T9o",
  },
  "3bet": {
    ip: "QQ-22,AQs-A2s,K9s+,Q9s+,J9s+,T8s+,97s+,87s,76s,65s,AQo-ATo,KJo+",
    oop: "TT+,A9s+,KTs+,QTs+,JTs,A5s-A2s,AJo+,KQo",
  },
  "4bet": { ip: "TT+,AQs+,AKo,KQs", oop: "QQ+,AKs,AKo,A5s-A4s" },
  limped: {
    ip: "99-22,A9s-A2s,KTs-K2s,Q2s+,J2s+,T2s+,92s+,82s+,72s+,62s+,52s+,42s+,32s,ATo-A2o,KJo-K2o,Q2o+,J2o+,T2o+,92o+,82o+,72o+,62o+,52o+,42o+,32o",
    oop: "22+,A2s+,K2s+,Q2s+,J4s+,T6s+,96s+,85s+,74s+,63s+,53s+,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,98o",
  },
};

export const rangeKey = (potType: PotType, ip: Position, oop: Position) => `${potType}:${ip}v${oop}`;

/** The preflop line a table entry stands for, e.g. "BTN open vs BB call". */
export function describeLine(potType: PotType, a: Position, b: Position): string {
  const [o, c] = PREFLOP_ORDER.indexOf(a) < PREFLOP_ORDER.indexOf(b) ? [a, b] : [b, a];
  switch (potType) {
    case "srp":
      return `${o} open vs ${c} call`;
    case "3bet":
      return `${o} open, ${c} 3-bet, ${o} call`;
    case "4bet":
      return `${o} open, ${c} 3-bet, ${o} 4-bet, ${c} call`;
    case "limped":
      return `${o} limp vs ${c} check`;
  }
}

export type RangeLookup = {
  pair: RangePair;
  /** Where the pair came from, worded to follow "Assumed ". */
  source: string;
  fallback: boolean;
};

/**
 * Ranges for a pot type and IP/OOP seats. Falls back to the generic pair for
 * the pot type when the table has no entry, and says so in `source`.
 */
export function lookupRanges(
  potType: PotType,
  ip: Position,
  oop: Position,
  table: Readonly<Partial<Record<string, RangePair>>> = PREFLOP_100BB,
  fallback: Readonly<Record<PotType, RangePair>> = GENERIC_RANGES,
): RangeLookup {
  const hit = table[rangeKey(potType, ip, oop)];
  if (hit) {
    return { pair: hit, source: `standard 100bb ranges: ${describeLine(potType, ip, oop)}`, fallback: false };
  }
  return {
    pair: fallback[potType],
    source: `generic ${potType} ranges (no standard 100bb ranges for ${ip} vs ${oop})`,
    fallback: true,
  };
}

const BLINDS: Partial<Record<Position, number>> = { SB: 0.5, BB: 1 };
const fmt = (n: number) => String(Math.round(n * 100) / 100);

export const sizesKey = (ip: Position, oop: Position) => `${ip}v${oop}`;

export type StandardPot = {
  /** Pot at the start of the flop, dead blinds included. */
  potBb: number;
  /** What each player put in preflop. */
  investedBb: number;
  /** The preflop line, e.g. "CO opens 2.5bb, BTN calls, blinds fold". */
  line: string;
};

/**
 * Flop pot and per-player investment for the standard line between two seats,
 * from the size table. Blinds of seats not in the hand are dead money. Null
 * when a raised pot's seat pair has no sizes.
 */
export function standardPot(
  potType: PotType,
  ip: Position,
  oop: Position,
  sizes: Readonly<Partial<Record<string, LineSizes>>> = PREFLOP_SIZES_100BB,
): StandardPot | null {
  const [o, c] = PREFLOP_ORDER.indexOf(ip) < PREFLOP_ORDER.indexOf(oop) ? [ip, oop] : [oop, ip];
  let each: number;
  let steps: string[];
  if (potType === "limped") {
    each = 1;
    steps = [`${o} limps`, c === "BB" ? "BB checks" : `${c} limps`];
  } else {
    const s = sizes[sizesKey(ip, oop)];
    if (!s) return null;
    const open = `${o} opens ${fmt(s.open)}bb`;
    const threeBet = `${c} 3-bets to ${fmt(s.threeBet)}bb`;
    if (potType === "srp") {
      each = s.open;
      steps = [open, `${c} calls`];
    } else if (potType === "3bet") {
      each = s.threeBet;
      steps = [open, threeBet, `${o} calls`];
    } else {
      each = s.fourBet;
      steps = [open, threeBet, `${o} 4-bets to ${fmt(s.fourBet)}bb`, `${c} calls`];
    }
  }
  const folded = (["SB", "BB"] as const).filter((b) => b !== o && b !== c);
  const dead = folded.reduce((sum, b) => sum + BLINDS[b]!, 0);
  if (folded.length === 2) steps.push("blinds fold");
  else if (folded.length === 1) steps.push(`${folded[0]} folds`);
  return { potBb: 2 * each + dead, investedBb: each, line: steps.join(", ") };
}
