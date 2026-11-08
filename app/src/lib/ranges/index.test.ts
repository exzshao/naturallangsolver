import { describe, expect, it } from "vitest";
import { handWeightInRange, orderPositions } from "../poker";
import { POT_TYPES, type Position } from "../schema";
import {
  describeLine,
  GENERIC_RANGES,
  lookupRanges,
  PREFLOP_100BB,
  PREFLOP_ORDER,
  PREFLOP_SIZES_100BB,
  rangeKey,
  sizesKey,
  standardPot,
} from ".";

const CLASS_RE = /^([AKQJT98765432])([AKQJT98765432])([so]?)(?::(\d*\.?\d+))?$/;
const RANKS = "AKQJT98765432";

/** Weighted combos in a range made only of hand classes ("AKs:0.5,QQ,..."). */
function combos(range: string): number {
  let total = 0;
  const seen = new Set<string>();
  for (const tok of range.split(",")) {
    const m = CLASS_RE.exec(tok);
    if (!m) throw new Error(`bad token ${tok}`);
    const [, a, b, s, w] = m;
    const pair = a === b;
    if (pair ? s !== "" : s === "" || RANKS.indexOf(a) > RANKS.indexOf(b)) throw new Error(`bad class ${tok}`);
    const cls = a + b + s;
    if (seen.has(cls)) throw new Error(`duplicate class ${cls}`);
    seen.add(cls);
    const weight = w === undefined ? 1 : Number(w);
    if (!(weight > 0 && weight <= 1)) throw new Error(`weight out of range ${tok}`);
    total += (pair ? 6 : s === "s" ? 4 : 12) * weight;
  }
  return total;
}

const pct = (range: string) => (100 * combos(range)) / 1326;

// Every heads-up line the table covers: opener before caller in preflop order.
const PAIRS: [Position, Position][] = [];
for (let i = 0; i < PREFLOP_ORDER.length; i++) {
  for (let j = i + 1; j < PREFLOP_ORDER.length; j++) {
    if (PREFLOP_ORDER[i] !== "BB") PAIRS.push([PREFLOP_ORDER[i], PREFLOP_ORDER[j]]);
  }
}

describe("preflop 100bb table", () => {
  it("has 15 pairs per raised pot type plus SB vs BB limped", () => {
    expect(PAIRS).toHaveLength(15);
    expect(Object.keys(PREFLOP_100BB)).toHaveLength(46);
  });

  it.each(["srp", "3bet", "4bet"] as const)("every %s pair resolves from the table", (potType) => {
    for (const [a, b] of PAIRS) {
      const { oop, ip } = orderPositions(a, b);
      const r = lookupRanges(potType, ip, oop);
      expect(r.fallback, `${potType} ${a} v ${b}`).toBe(false);
      expect(r.pair).toBe(PREFLOP_100BB[rangeKey(potType, ip, oop)]);
      expect(r.source).toBe(`standard 100bb ranges: ${describeLine(potType, a, b)}`);
    }
  });

  it("every range has valid classes, weights in (0, 1] and combos > 0, and parses", () => {
    for (const [key, pair] of Object.entries(PREFLOP_100BB)) {
      for (const range of [pair.ip, pair.oop]) {
        expect(combos(range), key).toBeGreaterThan(0);
        expect(handWeightInRange(range, "2c2d"), key).not.toBeNull();
      }
    }
  });

  it("open ranges are in plausible bands", () => {
    const open = (p: Position, key: string, side: "ip" | "oop") => [p, pct(PREFLOP_100BB[key]![side])] as const;
    const opens = Object.fromEntries([
      open("UTG", "srp:UTGvBB", "ip"),
      open("HJ", "srp:HJvBB", "ip"),
      open("CO", "srp:COvBB", "ip"),
      open("BTN", "srp:BTNvBB", "ip"),
      open("SB", "srp:BBvSB", "oop"),
    ]);
    expect(opens.UTG).toBeGreaterThan(14);
    expect(opens.UTG).toBeLessThan(20);
    expect(opens.HJ).toBeGreaterThan(opens.UTG);
    expect(opens.CO).toBeGreaterThan(opens.HJ);
    expect(opens.BTN).toBeGreaterThan(38);
    expect(opens.BTN).toBeLessThan(52);
    // The opener's range is the same whoever calls.
    expect(PREFLOP_100BB["srp:BTNvBB"]!.ip).toBe(PREFLOP_100BB["srp:BTNvSB"]!.ip);
  });

  it("ranges narrow from srp to 3-bet to 4-bet pots", () => {
    const k = (t: string) => PREFLOP_100BB[`${t}:BTNvBB`]!;
    expect(pct(k("3bet").oop)).toBeLessThan(pct(k("srp").oop));
    expect(pct(k("4bet").ip)).toBeLessThan(pct(k("3bet").ip));
  });
});

describe("lookupRanges", () => {
  it("falls back to the generic pair for missing entries, with a reason", () => {
    const r = lookupRanges("limped", "BTN", "CO");
    expect(r.fallback).toBe(true);
    expect(r.pair).toBe(GENERIC_RANGES.limped);
    expect(r.source).toBe("generic limped ranges (no standard 100bb ranges for BTN vs CO)");
  });

  it.each(POT_TYPES)("falls back for %s when the table is empty", (potType) => {
    const r = lookupRanges(potType, "BTN", "BB", {});
    expect(r.fallback).toBe(true);
    expect(r.pair).toBe(GENERIC_RANGES[potType]);
  });

  it("generic ranges parse", () => {
    for (const pair of Object.values(GENERIC_RANGES)) {
      expect(handWeightInRange(pair.ip, "2c2d")).not.toBeNull();
      expect(handWeightInRange(pair.oop, "2c2d")).not.toBeNull();
    }
  });

  it("describes lines with the opener first, in either argument order", () => {
    expect(describeLine("srp", "BB", "BTN")).toBe("BTN open vs BB call");
    expect(describeLine("3bet", "CO", "BTN")).toBe("CO open, BTN 3-bet, CO call");
    expect(describeLine("4bet", "BB", "SB")).toBe("SB open, BB 3-bet, SB 4-bet, BB call");
    expect(describeLine("limped", "BB", "SB")).toBe("SB limp vs BB check");
  });
});

describe("preflop sizes", () => {
  it("every seat pair in the range table has sizes, and nothing else does", () => {
    const pairs = new Set(
      Object.keys(PREFLOP_100BB)
        .filter((k) => !k.startsWith("limped:"))
        .map((k) => k.split(":")[1]),
    );
    expect(new Set(Object.keys(PREFLOP_SIZES_100BB))).toEqual(pairs);
    for (const [a, b] of PAIRS) {
      const { oop, ip } = orderPositions(a, b);
      expect(PREFLOP_SIZES_100BB[sizesKey(ip, oop)], `${a} v ${b}`).toBeDefined();
    }
  });

  it("sizes escalate: open < 3-bet < 4-bet, within the stated bands", () => {
    for (const [key, s] of Object.entries(PREFLOP_SIZES_100BB)) {
      expect(s.open, key).toBe(key === "BBvSB" ? 3.5 : 2.5);
      expect(s.threeBet, key).toBeGreaterThanOrEqual(8);
      expect(s.threeBet, key).toBeLessThanOrEqual(13);
      expect(s.fourBet, key).toBeGreaterThanOrEqual(20);
      expect(s.fourBet, key).toBeLessThanOrEqual(27.5);
      expect(s.fourBet, key).toBeGreaterThan(2 * s.threeBet - 1);
    }
  });

  it("standardPot adds dead blinds of seats not in the hand", () => {
    expect(standardPot("srp", "BTN", "CO")).toEqual({
      potBb: 6.5,
      investedBb: 2.5,
      line: "CO opens 2.5bb, BTN calls, blinds fold",
    });
    expect(standardPot("srp", "BTN", "BB")?.potBb).toBe(5.5);
    expect(standardPot("srp", "BB", "SB")?.potBb).toBe(7);
    expect(standardPot("limped", "BB", "SB")).toEqual({ potBb: 2, investedBb: 1, line: "SB limps, BB checks" });
    expect(standardPot("3bet", "BTN", "BB", {})).toBeNull();
  });
});
