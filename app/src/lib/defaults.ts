// Defaults (SPEC §5). Pure function: fills everything the user didn't say and
// records each applied default as a human-readable assumption. All tunable
// values live in DEFAULTS.
import { inferHeroIp, inferPotType, potFromHistory } from "./history";
import {
  handWeightInRange,
  heroPlayer,
  orderPositions,
  parseCards,
  parseHand,
  STREET_BY_CARD_COUNT,
} from "./poker";
import type { Extraction, Position, PotType, Street } from "./schema";
import type { BetSizesByStreet, Player } from "./types";

export type RangePair = { ip: string; oop: string };

const SRP_BTN_BB: RangePair = {
  ip: "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o",
  oop: "JJ-22,AJs-A2s,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,75s+,64s+,53s+,AJo-A2o,K9o+,Q9o+,J9o+,T9o",
};

const THREEBET_BB_BTN: RangePair = {
  ip: "QQ-22,AQs-A2s,K9s+,Q9s+,J9s+,T8s+,97s+,87s,76s,65s,AQo-ATo,KJo+",
  oop: "TT+,A9s+,KTs+,QTs+,JTs,A5s-A2s,AJo+,KQo",
};

export const DEFAULTS = {
  /** Both positions missing. Hero takes the IP seat. */
  positions: { ip: "BTN", oop: "BB" } as { ip: Position; oop: Position },
  /**
   * One position missing: the other seat by pot type. srp: BB defends vs the
   * opener. 3bet/4bet: the opener calls the blind 3-bettor.
   */
  otherPosition: {
    srp: { BB: "BTN", default: "BB" },
    "3bet": { BB: "BTN", SB: "BTN", default: "BB" },
    "4bet": { BB: "BTN", SB: "BTN", default: "BB" },
    limped: { BB: "SB", default: "BB" },
  } as Record<PotType, Partial<Record<Position, Position>> & { default: Position }>,
  potType: "srp" as PotType,
  startingStackBb: 100,
  /** Pot and effective stack at the start of the flop, assuming 100bb starting stacks. */
  flopPotStack: {
    srp: { potBb: 5.5, stackBb: 97.5 },
    "3bet": { potBb: 20, stackBb: 90 },
    "4bet": { potBb: 45, stackBb: 77.5 },
    limped: { potBb: 2, stackBb: 99 },
  } as Record<PotType, { potBb: number; stackBb: number }>,
  /** Keyed by `${potType}:${ip}v${oop}`. */
  ranges: {
    "srp:BTNvBB": SRP_BTN_BB,
    "srp:COvBB": {
      ip: "22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,86s+,75s+,65s,54s,A8o+,KTo+,QTo+,JTo",
      oop: "TT-22,AJs-A2s,K2s+,Q6s+,J7s+,T7s+,97s+,86s+,75s+,64s+,54s,AJo-A7o,KTo+,QTo+,JTo",
    },
    "srp:BBvSB": {
      ip: "TT-22,AJs-A2s,KJs-K2s,Q4s+,J6s+,T6s+,96s+,85s+,74s+,64s+,53s+,AJo-A2o,KJo-K7o,Q9o+,J9o+,T9o",
      oop: "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K7o+,Q9o+,J9o+,T9o",
    },
    "3bet:BTNvSB": {
      ip: "QQ-22,AQs-A2s,K9s+,Q9s+,J9s+,T8s+,98s,87s,76s,65s,AQo-ATo,KJo+",
      oop: "99+,ATs+,KTs+,QTs+,JTs,A5s-A4s,AQo+,KQo",
    },
    "3bet:BTNvBB": THREEBET_BB_BTN,
  } as Partial<Record<string, RangePair>>,
  fallbackRanges: {
    srp: SRP_BTN_BB,
    "3bet": THREEBET_BB_BTN,
    "4bet": { ip: "TT+,AQs+,AKo,KQs", oop: "QQ+,AKs,AKo,A5s-A4s" },
    limped: {
      ip: "99-22,A9s-A2s,KTs-K2s,Q2s+,J2s+,T2s+,92s+,82s+,72s+,62s+,52s+,42s+,32s,ATo-A2o,KJo-K2o,Q2o+,J2o+,T2o+,92o+,82o+,72o+,62o+,52o+,42o+,32o",
      oop: "22+,A2s+,K2s+,Q2s+,J4s+,T6s+,96s+,85s+,74s+,63s+,53s+,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,98o",
    },
  } as Record<PotType, RangePair>,
  /** Spots starting on the turn or river: both players, every street. */
  betSizes: { bet: "33%, 75%", raise: "3x", riverExtraBet: "a" },
  /**
   * Spots starting on the flop: one bet size per street and no raises
   * ("" = none). The §5 full tree needs ~20GB; this one is ~520MB / ~7s.
   */
  flopTreeBetSizes: {
    flop: { bet: "50%", raise: "" },
    turn: { bet: "75%", raise: "" },
    river: { bet: "75%", raise: "" },
  } as BetSizesByStreet,
  /** null = the solver's defaults. */
  donkSizes: null,
  /** Mirrored by the solver's TreeConfig; not part of the request. */
  thresholds: { addAllin: 1.5, forceAllin: 0.15, merging: 0.1, rake: 0 },
  maxIterations: 1000,
  /** Percent of the starting pot. */
  targetExploitabilityPct: 0.5,
};

export type ResolvedSpot = {
  board: string;
  street: Exclude<Street, "preflop">;
  heroPosition: Position;
  villainPosition: Position;
  oopPosition: Position;
  ipPosition: Position;
  heroPlayer: Player;
  heroHand: string | null;
  potType: PotType;
  potBb: number;
  effectiveStackBb: number;
  oopRange: string;
  ipRange: string;
  betSizes: BetSizesByStreet;
  maxIterations: number;
  targetExploitabilityPct: number;
};

export type DefaultsResult = { spot: ResolvedSpot; assumptions: string[] };

const fmt = (n: number) => String(Math.round(n * 100) / 100);

const POT_LABEL: Record<PotType, string> = {
  srp: "single raised pot",
  "3bet": "3-bet pot",
  "4bet": "4-bet pot",
  limped: "limped pot",
};

export function otherPosition(potType: PotType, known: Position): Position {
  const table = DEFAULTS.otherPosition[potType];
  return table[known] ?? table.default;
}

export const FLOP_TREE_ASSUMPTION =
  "Simplified flop tree (one bet size, no raises) to keep solve time reasonable";

function resolveBetSizes(
  street: Exclude<Street, "preflop">,
  userBet: string | null,
  userRaise: string | null,
): BetSizesByStreet {
  const base: BetSizesByStreet =
    street === "flop"
      ? DEFAULTS.flopTreeBetSizes
      : {
          flop: { bet: DEFAULTS.betSizes.bet, raise: DEFAULTS.betSizes.raise },
          turn: { bet: DEFAULTS.betSizes.bet, raise: DEFAULTS.betSizes.raise },
          river: {
            bet: `${DEFAULTS.betSizes.bet}, ${DEFAULTS.betSizes.riverExtraBet}`,
            raise: DEFAULTS.betSizes.raise,
          },
        };
  const pick = (s: keyof BetSizesByStreet) => ({
    bet: userBet ?? base[s].bet,
    raise: userRaise ?? base[s].raise,
  });
  return { flop: pick("flop"), turn: pick("turn"), river: pick("river") };
}

/**
 * Apply SPEC §5 defaults. Precondition: validateExtraction(x) returned null
 * (in particular, x.board is a valid 3-5 card board).
 */
export function applyDefaults(x: Extraction): DefaultsResult {
  const assumptions: string[] = [];
  const boardCards = parseCards(x.board ?? "");
  if (!boardCards || !(boardCards.length in STREET_BY_CARD_COUNT)) {
    throw new Error("applyDefaults called with an invalid board; run validateExtraction first");
  }
  const board = boardCards.join("");
  const street = STREET_BY_CARD_COUNT[boardCards.length];

  // Pot type: stated, else implied by the preflop action, else the default.
  let potType = x.pot_type ?? inferPotType(x.actions);
  if (!potType) {
    potType = DEFAULTS.potType;
    assumptions.push(`Assumed a ${POT_LABEL[potType]}`);
  }

  // Positions
  let hero = x.hero_position;
  let villain = x.villain_position;
  if (hero && villain && hero === villain) {
    assumptions.push(`Ignored villain position ${villain} (same seat as hero)`);
    villain = null;
  }
  if (!hero && !villain) {
    // Who acts first after the flop tells us who is out of position.
    const heroIp = inferHeroIp(x.actions) ?? true;
    hero = heroIp ? DEFAULTS.positions.ip : DEFAULTS.positions.oop;
    villain = heroIp ? DEFAULTS.positions.oop : DEFAULTS.positions.ip;
    assumptions.push(
      `Assumed ${DEFAULTS.positions.ip} (IP) vs ${DEFAULTS.positions.oop} (OOP), with hero on the ${hero}`,
    );
  } else if (!villain) {
    villain = otherPosition(potType, hero!);
    assumptions.push(`Assumed villain is in the ${villain}`);
  } else if (!hero) {
    hero = otherPosition(potType, villain);
    assumptions.push(`Assumed hero is in the ${hero}`);
  }
  const { oop, ip } = orderPositions(hero!, villain!);
  const heroSeat = heroPlayer(hero!, villain!);

  // Pot and stacks. Priority: what the user stated, then the action
  // history, then the standard pot for the pot type ("checked through").
  // A stated pot also skips the history for the stack (each player put in
  // half the pot), so the two never disagree.
  const flop = DEFAULTS.flopPotStack[potType];
  let starting = x.starting_stack_bb;
  const startingAssumption = starting === null;
  if (starting === null) starting = DEFAULTS.startingStackBb;
  const history = potFromHistory(x, {
    street,
    heroPosition: hero!,
    villainPosition: villain!,
    standardFlop: { potBb: flop.potBb, investedBb: DEFAULTS.startingStackBb - flop.stackBb },
    potLabel: POT_LABEL[potType],
  });

  let potBb = x.pot_bb;
  if (potBb === null && history) {
    potBb = history.potBb;
    assumptions.push(...history.assumptions);
    assumptions.push(`Computed a ${fmt(potBb)}bb pot at the start of the ${street} from the betting`);
  } else if (potBb === null) {
    potBb = flop.potBb;
    assumptions.push(`Assumed a ${fmt(potBb)}bb pot (standard ${POT_LABEL[potType]} at the flop)`);
    if (street !== "flop") assumptions.push("Assumed it checked through previous streets");
  }
  let stackBb = x.effective_stack_bb;
  if (stackBb === null) {
    if (startingAssumption) assumptions.push(`Assumed ${fmt(starting)}bb effective stacks (starting stack)`);
    if (history && x.pot_bb === null) {
      stackBb = starting - history.investedBb;
      assumptions.push(
        `Computed a ${fmt(stackBb)}bb effective stack at the start of the ${street} (${fmt(starting)}bb minus ${fmt(history.investedBb)}bb put in)`,
      );
    } else {
      // Without a stated pot, use the standard preflop investment for the pot
      // type; otherwise assume each player put in half the pot.
      const invested = x.pot_bb === null ? DEFAULTS.startingStackBb - flop.stackBb : x.pot_bb / 2;
      stackBb = starting - invested;
      assumptions.push(`Assumed ${fmt(stackBb)}bb effective stack at the start of the ${street}`);
    }
  }

  // Ranges
  const key = `${potType}:${ip}v${oop}`;
  const seeded = DEFAULTS.ranges[key];
  const pair = seeded ?? DEFAULTS.fallbackRanges[potType];
  const source = seeded
    ? `default ${potType} ranges for ${ip} (IP) vs ${oop} (OOP)`
    : `generic ${potType} ranges (no table entry for ${ip} vs ${oop})`;
  let oopRange = x.oop_range ?? pair.oop;
  let ipRange = x.ip_range ?? pair.ip;
  if (x.oop_range === null && x.ip_range === null) {
    assumptions.push(`Assumed ${source}`);
  } else if (x.oop_range === null) {
    assumptions.push(`Assumed OOP (${oop}) range from ${source}`);
  } else if (x.ip_range === null) {
    assumptions.push(`Assumed IP (${ip}) range from ${source}`);
  }

  // Hero hand
  let heroHand: string | null = null;
  if (x.hero_hand !== null) {
    heroHand = parseHand(x.hero_hand);
    if (heroHand === null) {
      assumptions.push(`Ignored hero hand "${x.hero_hand}" (needs two exact cards, e.g. AhKh)`);
    }
  }
  if (heroHand !== null) {
    const heroRange = heroSeat === "oop" ? oopRange : ipRange;
    if (handWeightInRange(heroRange, heroHand) === 0) {
      // postflop-solver gives the FIRST group covering a hand precedence, so
      // the hand goes in front to guarantee weight 1.
      const updated = `${heroHand},${heroRange}`;
      if (heroSeat === "oop") oopRange = updated;
      else ipRange = updated;
      assumptions.push(`Added hero's hand ${heroHand} to the ${heroSeat.toUpperCase()} range at weight 1`);
    }
  }

  // Bet sizes. Turn/river spots use the full §5 tree. Flop spots use a
  // simplified tree: the full one needs ~20GB and is always TREE_TOO_LARGE.
  const userBet = x.bet_sizes?.bet ?? null;
  const userRaise = x.bet_sizes?.raise ?? null;
  const betSizes = resolveBetSizes(street, userBet, userRaise);
  if (street === "flop") {
    if (userBet === null && userRaise === null) {
      assumptions.push(FLOP_TREE_ASSUMPTION);
    } else if (userBet === null) {
      assumptions.push("Assumed one bet size per street (50% flop, 75% turn and river) to keep the flop tree small");
    } else if (userRaise === null) {
      assumptions.push("Assumed no raises to keep the flop tree small");
    }
  } else {
    // Only the streets the solver plays from here on.
    const d = DEFAULTS.betSizes;
    const streets = street === "turn" ? "turn and river" : "river";
    const bets = street === "turn" ? `${d.bet}, plus all-in on the river` : `${d.bet}, all-in`;
    if (userBet === null && userRaise === null) {
      assumptions.push(`Bet sizes the solver considers on the ${streets}: ${bets}; raises ${d.raise} (you didn't specify)`);
    } else if (userBet === null) {
      assumptions.push(`Bet sizes the solver considers on the ${streets}: ${bets} (you didn't specify)`);
    } else if (userRaise === null) {
      assumptions.push(`Raise size the solver considers on the ${streets}: ${d.raise} (you didn't specify)`);
    }
  }

  return {
    spot: {
      board,
      street,
      heroPosition: hero!,
      villainPosition: villain!,
      oopPosition: oop,
      ipPosition: ip,
      heroPlayer: heroSeat,
      heroHand,
      potType,
      potBb,
      effectiveStackBb: stackBb,
      oopRange,
      ipRange,
      betSizes,
      maxIterations: DEFAULTS.maxIterations,
      targetExploitabilityPct: DEFAULTS.targetExploitabilityPct,
    },
    assumptions,
  };
}
