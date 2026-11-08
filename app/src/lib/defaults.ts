// Defaults (SPEC §5). Pure function: fills everything the user didn't say and
// records each applied default as a human-readable assumption. All tunable
// values live in DEFAULTS.
import { inferHeroIp, inferPotType, potFromHistory } from "./history";
import { NO_LINE_ASSUMPTION, POT_TOO_SMALL_NO_LINE, type SpotLine, USER_RANGES_NO_LINE } from "./line";
import {
  handWeightInRange,
  heroPlayer,
  orderPositions,
  parseCards,
  parseHand,
  STREET_BY_CARD_COUNT,
} from "./poker";
import type { Extraction, Position, PotType, Street } from "./schema";
import { type AddedSize, addedSizesText } from "./street";
import {
  GENERIC_RANGES,
  type LineSizes,
  lookupRanges,
  PREFLOP_100BB,
  PREFLOP_ORDER,
  PREFLOP_SIZES_100BB,
  type RangePair,
  standardPot,
} from "./ranges";
import type { BetSizesByStreet, Player, SolverTreeChoice } from "./types";

export type { RangePair };

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
  /** Turn/river: a stated pot up to this much over the flop pot, with bets after the flop pot, is read as the flop pot. */
  earlierPotToleranceBb: 0.5,
  /**
   * Preflop raise sizes per seat pair, keyed by `${ip}v${oop}` (see ./ranges).
   * The flop pot and each player's investment come from these when neither a
   * pot nor a usable action history is given; blinds of seats not in the hand
   * are dead money (CO vs BTN srp: 2.5 + 2.5 + 1.5 = 6.5bb).
   */
  preflopSizes: PREFLOP_SIZES_100BB as Readonly<Partial<Record<string, LineSizes>>>,
  /**
   * Pot and effective stack at the start of the flop, assuming 100bb starting
   * stacks, for seat pairs missing from preflopSizes.
   */
  flopPotStack: {
    srp: { potBb: 5.5, stackBb: 97.5 },
    "3bet": { potBb: 20, stackBb: 90 },
    "4bet": { potBb: 45, stackBb: 77.5 },
    limped: { potBb: 2, stackBb: 99 },
  } as Record<PotType, { potBb: number; stackBb: number }>,
  /**
   * Preflop ranges by position and pot type, 100bb, keyed by
   * `${potType}:${ip}v${oop}` (see ./ranges). Pairs not in the table use
   * fallbackRanges for the pot type.
   */
  ranges: PREFLOP_100BB as Readonly<Partial<Record<string, RangePair>>>,
  fallbackRanges: GENERIC_RANGES,
  /** Spots starting on the turn or river: both players, every street. */
  betSizes: { bet: "33%, 75%", raise: "3x", riverExtraBet: "a" },
  /**
   * Spots starting on the flop (SPEC §5 "flop tree"). The §5 full tree needs ~20GB.
   * Built around the preflop raiser: it c-bets `cbets[i]`; the caller gets a
   * `callerRaise` (a check-raise when OOP), an OOP caller doesn't lead, an IP caller
   * may bet `stab` when checked to. Limped pots: both bet, OOP can check-raise.
   * Turn and river: `later` bets, no raises, no leads into the previous street's
   * bettor. One tree per `cbets` entry, richest first: the solver solves the first
   * estimated within its time budget (wide single-raised pots on rainbow boards get
   * the 33%-only tree). Measured (M1, wide BTN v BB): 33%/75% ~650MB raw / ~8s on
   * Td9d6h, 33% ~650MB / ~11s on Ks7d2c; Fly is ~2x slower.
   */
  flopTree: { cbets: ["33%, 75%", "33%"], callerRaise: "3x", stab: "33%", later: "75%" },
  /** Flop spots where the user gave a bet or raise size: what fills the rest (every street). */
  flopUserBase: { flop: "33%", later: "75%", raise: "" },
  /** Turn/river spots: null = the solver's defaults (OOP leads with its bet sizes). Default flop trees send donk "" instead (see flopTree). */
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
  /** Simpler trees the solver may fall back to under its time budget (default flop trees). */
  betSizeFallbacks: BetSizesByStreet[];
  /** Set when the default flop trees are used: what their assumption text is built from. */
  flopTreeSeats: FlopTreeSeats | null;
  /** Preflop raiser's seat (null in limped pots); the solver's line narrowing uses it. */
  preflopAggressor: Player | null;
  maxIterations: number;
  targetExploitabilityPct: number;
  /** Turn/river spots with earlier postflop action: the line the solver narrows ranges with. */
  line: SpotLine | null;
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

/**
 * The preflop raiser's seat (the last aggressor), from the pot type and seats: the
 * opener in single-raised and 4-bet pots, the 3-bettor in 3-bet pots. Null in limped pots.
 */
export function preflopAggressor(potType: PotType, a: Position, b: Position): Player | null {
  if (potType === "limped") return null;
  const opener = PREFLOP_ORDER.indexOf(a) < PREFLOP_ORDER.indexOf(b) ? a : b;
  const aggressor = potType === "3bet" ? (opener === a ? b : a) : opener;
  return orderPositions(a, b).oop === aggressor ? "oop" : "ip";
}

/** Seats and raiser a flop tree is described with. */
export type FlopTreeSeats = { oop: Position; ip: Position; aggressor: Player | null };

/** Default flop trees for the seats, richest first (see DEFAULTS.flopTree). */
export function flopTrees(aggressor: Player | null): BetSizesByStreet[] {
  const t = DEFAULTS.flopTree;
  const later = { bet: t.later, raise: "", donk: "" };
  return t.cbets.map((cbet) => ({
    flop:
      aggressor === "ip"
        ? { bet: cbet, raise: "", oop: { bet: "", raise: t.callerRaise } }
        : aggressor === "oop"
          ? { bet: cbet, raise: "", ip: { bet: t.stab, raise: t.callerRaise } }
          : { bet: cbet, raise: "", oop: { raise: t.callerRaise } },
    turn: later,
    river: later,
  }));
}

const orSizes = (list: string) => list.split(/,\s*/).join(" or ");

/** Assumption text for the flop's one-size-per-street default (user gave only a raise). */
export const FLOP_ONE_SIZE_ASSUMPTION = `Assumed one bet size per street (${DEFAULTS.flopUserBase.flop} flop, ${DEFAULTS.flopUserBase.later} turn and river) to keep the flop tree small`;
/** Assumption text for the flop's no-raise default (user gave only a bet size). */
export const FLOP_NO_RAISES_ASSUMPTION = "Assumed no raises to keep the flop tree small";

/**
 * Assumption describing a default flop tree: "Flop tree: BTN (preflop raiser) bets 33% or 75%,
 * BB can check-raise 3x and doesn't lead; turn and river: 75% bets, no raises or leads into
 * the last bettor". `raises: false` for the auto-simplified tree without raises. `added`:
 * flop sizes the solved tree has on top (from the described action); a clause they
 * contradict ("doesn't lead", "no raises") is dropped or becomes "no other raises", and
 * they are listed: "…, BB can check-raise 3x; added: BB's 4bb lead (from your description); …".
 */
export function flopTreeAssumption(seats: FlopTreeSeats, cbet: string, raises = true, added: AddedSize[] = []): string {
  const t = DEFAULTS.flopTree;
  const later = `turn and river: ${t.later} bets, no raises or leads into the last bettor`;
  const r = raises ? t.callerRaise : null;
  const noRaises = added.some((a) => a.kind === "raise") ? "no other raises" : "no raises";
  const pos = (p: Player) => (p === "oop" ? seats.oop : seats.ip);
  // An OOP bet is a lead when the tree gives the OOP caller none.
  const isLead = (a: AddedSize) => seats.aggressor === "ip" && a.player === "oop" && a.kind === "bet";
  const leads = added.some(isLead);
  const list = added.length ? `; added: ${addedSizesText(added, (p) => `${pos(p)}'s`, isLead)}` : "";
  let flop: string;
  if (seats.aggressor === null) {
    flop = `both players bet ${orSizes(cbet)}${r ? `, ${seats.oop} can check-raise ${r}` : `, ${noRaises}`}`;
  } else {
    const agg = pos(seats.aggressor);
    const caller = seats.aggressor === "ip" ? seats.oop : seats.ip;
    const callerPart =
      seats.aggressor === "ip"
        ? r
          ? `${caller} can check-raise ${r}${leads ? "" : " and doesn't lead"}`
          : `${leads ? "" : `${caller} doesn't lead, `}${noRaises}`
        : r
          ? `${caller} can raise ${r} or bet ${t.stab} when checked to`
          : `${caller} can bet ${t.stab} when checked to, ${noRaises}`;
    flop = `${agg} (preflop raiser) bets ${orSizes(cbet)}, ${callerPart}`;
  }
  return `Flop tree: ${flop}${list}; ${later}`;
}

/** The solver's auto-simplification steps (SPEC §7 "Tree budget"), as text. */
const AUTO_TEXT: Record<string, string> = {
  no_raises: "raises dropped",
  one_size: "raises dropped and one bet size per street",
};

/**
 * Assumptions after the solve, describing the tree actually solved: the default flop tree's
 * text is swapped for the tree the solver picked under its time budget and names the sizes
 * added for the described action (`added`); other tree texts that those sizes contradict
 * ("no raises", "one bet size", an auto-simplified tree) say they were kept.
 */
export function treeChoiceAssumptions(
  spot: Pick<ResolvedSpot, "flopTreeSeats" | "betSizes" | "betSizeFallbacks">,
  assumptions: string[],
  tree: SolverTreeChoice | undefined,
  added: AddedSize[] = [],
): string[] {
  const chosen = !tree || (tree.index === 0 && !tree.auto) ? null : tree;
  const flopAdded = added.filter((a) => a.street === "flop");
  const seats = spot.flopTreeSeats;
  const trees = [spot.betSizes, ...spot.betSizeFallbacks];
  const keptRaise = added.some((a) => a.kind === "raise");
  const keptBet = added.some((a) => a.kind === "bet");
  const except = " (except the added sizes below)";
  let out = assumptions;
  if (keptRaise || keptBet) {
    out = out.map((a) =>
      a === FLOP_NO_RAISES_ASSUMPTION && keptRaise
        ? `${a}${except}`
        : a === FLOP_ONE_SIZE_ASSUMPTION && keptBet
          ? `${a}${except}`
          : a,
    );
  }
  if (!chosen && !(seats && flopAdded.length)) return out;
  const original = seats ? flopTreeAssumption(seats, trees[0].flop.bet) : null;
  let replacement: string;
  if (seats && (!chosen || (!chosen.auto && trees[chosen.index]))) {
    replacement = flopTreeAssumption(seats, trees[chosen?.index ?? 0].flop.bet, true, flopAdded);
  } else if (seats) {
    const cbet = chosen!.bet_sizes.flop.bet;
    replacement = `${flopTreeAssumption(seats, cbet, false, flopAdded)} (simplified to keep the solve fast)`;
  } else {
    const auto = AUTO_TEXT[chosen!.auto ?? ""] ?? "a smaller tree";
    replacement = `Tree simplified to keep the solve fast: ${auto}${added.length ? except : ""}`;
  }
  const i = original === null ? -1 : out.indexOf(original);
  return i >= 0 ? out.map((a, j) => (j === i ? replacement : a)) : [...out, replacement];
}

function resolveBetSizes(
  street: Exclude<Street, "preflop">,
  userBet: string | null,
  userRaise: string | null,
): BetSizesByStreet {
  const u = DEFAULTS.flopUserBase;
  const base: BetSizesByStreet =
    street === "flop"
      ? {
          flop: { bet: u.flop, raise: u.raise },
          turn: { bet: u.later, raise: u.raise },
          river: { bet: u.later, raise: u.raise },
        }
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
  // history, then the standard pot for the pot type and seats ("checked
  // through"). A stated pot also skips the history for the stack (each player
  // put in half the pot), so the two never disagree.
  const std = standardPot(potType, ip, oop, DEFAULTS.preflopSizes);
  const generic = DEFAULTS.flopPotStack[potType];
  const flop = std ?? {
    potBb: generic.potBb,
    investedBb: DEFAULTS.startingStackBb - generic.stackBb,
    line: null,
  };
  let starting = x.starting_stack_bb;
  const startingAssumption = starting === null;
  if (starting === null) starting = DEFAULTS.startingStackBb;
  const history = potFromHistory(x, {
    street,
    heroPosition: hero!,
    villainPosition: villain!,
    standardFlop: { potBb: flop.potBb, investedBb: flop.investedBb },
    potLabel: POT_LABEL[potType],
  });

  // A stated pot no bigger than the flop pot on a turn/river spot with flop (or
  // turn) bets after it is the pot of an earlier street ("leads 4bb into 5.5bb"):
  // add the later bets.
  let statedPot = x.pot_bb;
  if (
    statedPot !== null &&
    street !== "flop" &&
    history &&
    history.potBb > history.flopPotBb &&
    statedPot <= history.flopPotBb + DEFAULTS.earlierPotToleranceBb
  ) {
    const later = history.potBb - history.flopPotBb;
    assumptions.push(
      `Read your ${fmt(statedPot)}bb pot as the flop pot (bets came after it): ${fmt(statedPot + later)}bb at the start of the ${street}`,
    );
    statedPot += later;
  }

  let potBb = statedPot;
  if (potBb === null && history) {
    potBb = history.potBb;
    assumptions.push(...history.assumptions);
    assumptions.push(`Computed a ${fmt(potBb)}bb pot at the start of the ${street} from the betting`);
  } else if (potBb === null) {
    potBb = flop.potBb;
    assumptions.push(
      flop.line
        ? `Assumed a ${fmt(potBb)}bb pot: ${flop.line}`
        : `Assumed a ${fmt(potBb)}bb pot (standard ${POT_LABEL[potType]} at the flop)`,
    );
    if (street !== "flop") assumptions.push("Assumed it checked through previous streets");
  }
  let stackBb = x.effective_stack_bb;
  if (stackBb === null) {
    if (startingAssumption) assumptions.push(`Assumed ${fmt(starting)}bb effective stacks (starting stack)`);
    if (history && statedPot === null) {
      stackBb = starting - history.investedBb;
      assumptions.push(
        `Computed a ${fmt(stackBb)}bb effective stack at the start of the ${street} (${fmt(starting)}bb minus ${fmt(history.investedBb)}bb put in)`,
      );
    } else {
      // Without a stated pot, use the standard preflop investment for the pot
      // type and seats; otherwise assume each player put in half the pot.
      const invested = statedPot === null ? flop.investedBb : statedPot / 2;
      stackBb = starting - invested;
      assumptions.push(`Assumed ${fmt(stackBb)}bb effective stack at the start of the ${street}`);
    }
  }

  // Ranges
  const { pair, source } = lookupRanges(potType, ip, oop, DEFAULTS.ranges, DEFAULTS.fallbackRanges);
  let oopRange = x.oop_range ?? pair.oop;
  let ipRange = x.ip_range ?? pair.ip;
  if (x.oop_range === null && x.ip_range === null) {
    assumptions.push(`Assumed ${source}`);
  } else if (x.oop_range === null) {
    assumptions.push(`Assumed OOP (${oop}) range from ${source}`);
  } else if (x.ip_range === null) {
    assumptions.push(`Assumed IP (${ip}) range from ${source}`);
  }

  // Earlier-street line (turn/river): the solver narrows both ranges by
  // replaying it in a simplified flop solve. Only when some postflop action
  // before this street was actually described.
  let line: SpotLine | null = null;
  if (street !== "flop") {
    const described = history?.streets.some((s) => s.steps !== null && s.steps.length > 0) ?? false;
    if (!history || !described) {
      assumptions.push(NO_LINE_ASSUMPTION);
    } else if (x.oop_range !== null || x.ip_range !== null) {
      assumptions.push(USER_RANGES_NO_LINE);
    } else {
      // Per-player chips put in after the flop, taken off the (stated or derived) pot and stack.
      const postflopEach = (history.potBb - history.flopPotBb) / 2;
      const flopPotBb = potBb - 2 * postflopEach;
      const flopStackBb = stackBb + postflopEach;
      if (flopPotBb > 0 && flopStackBb > 0) line = { flopPotBb, flopStackBb, streets: history.streets };
      else assumptions.push(POT_TOO_SMALL_NO_LINE);
    }
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

  // Bet sizes. Turn/river spots use the full §5 tree. Flop spots use a tree built
  // around the preflop raiser (the full one needs ~20GB and is always TREE_TOO_LARGE),
  // with a simpler fallback the solver takes when the richer one would be too slow.
  const userBet = x.bet_sizes?.bet ?? null;
  const userRaise = x.bet_sizes?.raise ?? null;
  const aggressor = preflopAggressor(potType, hero!, villain!);
  let betSizes = resolveBetSizes(street, userBet, userRaise);
  let betSizeFallbacks: BetSizesByStreet[] = [];
  let flopTreeSeats: FlopTreeSeats | null = null;
  if (street === "flop") {
    if (userBet === null && userRaise === null) {
      [betSizes, ...betSizeFallbacks] = flopTrees(aggressor);
      flopTreeSeats = { oop, ip, aggressor };
      assumptions.push(flopTreeAssumption(flopTreeSeats, betSizes.flop.bet));
    } else if (userBet === null) {
      assumptions.push(FLOP_ONE_SIZE_ASSUMPTION);
    } else if (userRaise === null) {
      assumptions.push(FLOP_NO_RAISES_ASSUMPTION);
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
      betSizeFallbacks,
      flopTreeSeats,
      preflopAggressor: aggressor,
      maxIterations: DEFAULTS.maxIterations,
      targetExploitabilityPct: DEFAULTS.targetExploitabilityPct,
      line,
    },
    assumptions,
  };
}
