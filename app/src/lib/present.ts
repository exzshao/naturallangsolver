// Turns a solver result (chips) into the /api/solve response the UI renders
// (big blinds, % of pot, position labels). Pure; the UI does no unit math.
import { type ResolvedSpot, treeChoiceAssumptions } from "./defaults";
import { narrowingAssumptions } from "./line";
import { chipsToBb } from "./poker";
import type { SpotExtras } from "./request";
import {
  type AddedSize,
  addedStreetSizes,
  decisionText,
  describeStreetLine,
  facingText,
  nodeTitleText,
  type StreetLine,
  type StreetStep,
  streetAssumptions,
  streetNodeTitle,
} from "./street";
import type {
  CantSolveResponse,
  ClassWeight,
  HandClass,
  HeroAction,
  Player,
  SolverNode,
  SolverOkResponse,
  StreetBetSizes,
} from "./types";

export type DisplayAction = {
  action: HeroAction["action"];
  /** e.g. "Check", "Call 4.13bb", "Bet 2.75bb", "Raise 12.38bb", "All-in 97.5bb". */
  label: string;
  amountBb: number;
  /** Bet size as % of the pot at the node; null for everything else. */
  potPct: number | null;
  frequency: number;
  /** Hand classes that take this action most, largest share first. Empty for hero actions. */
  topClasses: HandClass[];
  /** Hero hand's EV of this action in bb (fold = 0); null for range actions. */
  evBb: number | null;
  /** Highest-EV action of hero's hand at the node. */
  best: boolean;
};

export type DisplayNode = {
  /** e.g. "BB acts first", "BTN after BB checks", "BB facing your 1.8bb bet (after checking)". */
  title: string;
  player: Player;
  position: string;
  isHero: boolean;
  actions: DisplayAction[];
};

/** Ranges after the stage-1 flop solve of the line (only when narrowing worked). */
export type DisplayNarrowing = {
  players: Record<
    Player,
    {
      position: string;
      combosBefore: number;
      combosAfter: number;
      /** Most combos first. */
      classes: ClassWeight[];
      /** Weighted range string the current street was solved with. */
      range: string;
      /** Share of the starting range that takes the line (null from older solvers). */
      lineProbability: number | null;
      /** Rare line: the range is blended toward the starting range. */
      blended: boolean;
    }
  >;
  flopSolveMs: number;
  iterations: number | null;
  exploitabilityPct: number | null;
};

export type SolveOkPayload = {
  status: "ok";
  spot: {
    board: string;
    street: ResolvedSpot["street"];
    potType: ResolvedSpot["potType"];
    heroPosition: string;
    villainPosition: string;
    oopPosition: string;
    ipPosition: string;
    heroPlayer: Player;
    heroHand: string | null;
    potBb: number;
    effectiveStackBb: number;
    oopRange: string;
    ipRange: string;
    betSizes: ResolvedSpot["betSizes"];
    /** Sizes the solved tree has on top of betSizes (the described street action, hero's raise at the decision). */
    addedSizes: AddedSize[];
  };
  assumptions: string[];
  /** Extraction notes (e.g. action already taken), shown verbatim. */
  notes: string | null;
  players: Record<Player, { position: string; equity: number; evBb: number }>;
  nodes: DisplayNode[];
  heroHand: {
    hand: string;
    nodeTitle: string;
    equity: number;
    evBb: number;
    /** e.g. "when BB checks" or "when you act first". */
    situation: string;
    /** The decision, for the card title: "facing BB all-in 97.5bb", "after BB checks", "acting first". */
    decision: string;
    /** The street action before it, when it was played: "BB checked, you bet 3bb, BB raised to 10bb". */
    streetAction: string | null;
    actions: DisplayAction[];
    /** EV-gap advice ("CLOSE: ...", "SLIGHT EDGE: ...", "CLEAR: ..."); null without 2+ EVs. */
    verdict: Verdict | null;
  } | null;
  narrowing: DisplayNarrowing | null;
  /** Present when the spot had action on the current street. */
  streetLine: {
    /** Nodes, players and hero hand are at hero's decision after the street action. */
    matched: boolean;
    /** Villain's range at hero's decision (when matched). */
    villainRange: { position: string; combosBefore: number; combosAfter: number; classes: ClassWeight[] } | null;
  } | null;
  /** Villain's known hand ("72o", "7c2d"), when given. */
  villainHand: string | null;
  stats: {
    exploitabilityPct: number;
    targetExploitabilityPct: number;
    iterations: number;
    solveMs: number;
    memoryMb: number;
    compressed: boolean;
  };
};

export type SolveApiResponse = SolveOkPayload | CantSolveResponse;

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

function fmtBb(bb: number): string {
  return `${round(bb)}bb`;
}

export function presentAction(
  a: HeroAction & { top_classes?: HandClass[] },
  potChips: number,
  toCallChips = 0,
): DisplayAction {
  const amountBb = chipsToBb(a.amount);
  const sized = a.action === "Bet" || a.action === "Raise" || a.action === "AllIn";
  const name = a.action === "AllIn" ? "All-in" : a.action;
  const label = sized
    ? `${name} ${fmtBb(amountBb)}`
    : a.action === "Call" && toCallChips > 0
      ? `Call ${fmtBb(chipsToBb(toCallChips))}`
      : name;
  return {
    action: a.action,
    label,
    amountBb,
    potPct: a.action === "Bet" && potChips > 0 ? round((a.amount / potChips) * 100, 0) : null,
    frequency: a.frequency,
    topClasses: a.top_classes ?? [],
    evBb: a.ev === undefined ? null : round(chipsToBb(a.ev)),
    best: false,
  };
}

/**
 * EVs closer than this are a tie. Actions a mixed strategy takes have equal EV in theory;
 * the gaps left at 0.5% exploitability are noise, so ties go to the more frequent action.
 */
export const EV_TIE_BB = 0.1;

/** Marks the highest-EV action (ties within EV_TIE_BB: the more frequent one). Needs 2+ EVs. */
export function markBest(actions: DisplayAction[]): DisplayAction[] {
  const withEv = actions.filter((a) => a.evBb !== null);
  if (withEv.length < 2) return actions;
  const top = withEv.reduce((b, a) =>
    a.evBb! > b.evBb! + EV_TIE_BB || (Math.abs(a.evBb! - b.evBb!) <= EV_TIE_BB && a.frequency > b.frequency) ? a : b,
  );
  return actions.map((a) => ({ ...a, best: a === top }));
}

/**
 * Verdict thresholds, as the EV gap between the best and second-best action over the pot
 * at the node (SPEC §9). Below CLOSE (or within EV_TIE_BB) the choice barely matters:
 * the solver stops at ~0.5% of pot exploitability, so gaps under 1% are near its noise.
 * From SLIGHT up to CLEAR one action is better but a mix is a small leak; above, it is a real mistake.
 */
export const VERDICT_CLOSE_POT = 0.01;
export const VERDICT_CLEAR_POT = 0.05;
/** CLEAR also needs at least this many bb, so tiny edges in small pots read as SLIGHT. */
export const VERDICT_CLEAR_MIN_BB = 1;

export type Verdict = {
  kind: "close" | "slight" | "clear";
  /** e.g. "CLOSE: EITHER BET 2.75bb OR CHECK IS FINE (0.29bb APART)", "CLEAR: CALL 97.5bb (+32.32bb OVER FOLD)". */
  text: string;
  /** EV(best) − EV(second best), bb. */
  gapBb: number;
  /** gapBb as a share of the pot at the node. */
  gapPot: number;
};

const upperLabel = (a: DisplayAction) => a.label.replace(/[A-Za-z-]+/g, (w) => (w === "bb" ? w : w.toUpperCase()));

/**
 * High-level advice for hero's hand from the EV gap between the two best actions,
 * independent of frequencies. Null without 2+ EVs or a pot.
 */
export function verdict(actions: DisplayAction[], potBb: number): Verdict | null {
  const marked = markBest(actions);
  const best = marked.find((a) => a.best);
  if (!best || !(potBb > 0)) return null;
  const rest = marked.filter((a) => a !== best && a.evBb !== null).sort((x, y) => y.evBb! - x.evBb!);
  const second = rest[0];
  // markBest may pick the more frequent of two tied actions, so the gap can be slightly negative.
  const gapBb = round(Math.max(0, best.evBb! - second.evBb!));
  const gapPot = gapBb / potBb;
  const closeBb = Math.max(EV_TIE_BB, VERDICT_CLOSE_POT * potBb);
  if (gapBb <= closeBb) {
    const close = [best, ...rest.filter((a) => best.evBb! - a.evBb! <= closeBb)];
    const spread = round(Math.max(...close.map((a) => Math.abs(best.evBb! - a.evBb!))));
    const names = close.map(upperLabel);
    const text =
      close.length === 2
        ? `CLOSE: EITHER ${names[0]} OR ${names[1]} IS FINE (${spread}bb APART)`
        : `CLOSE: ${names.slice(0, -1).join(", ")} OR ${names.at(-1)} ARE ALL FINE (WITHIN ${spread}bb)`;
    return { kind: "close", text, gapBb, gapPot };
  }
  const kind = gapPot < VERDICT_CLEAR_POT || gapBb < VERDICT_CLEAR_MIN_BB ? "slight" : "clear";
  const head = kind === "slight" ? "SLIGHT EDGE" : "CLEAR";
  return { kind, text: `${head}: ${upperLabel(best)} (+${gapBb}bb OVER ${upperLabel(second)})`, gapBb, gapPot };
}

/**
 * One street's sizes for the spot card: "33%, 75%; NO RAISE", or per player when the
 * players' options differ ("BTN 33%, 75%; NO RAISE · BB NONE; RAISE 3x"), then the sizes
 * the solved tree added: "· ADDED: BB LEAD 4bb, BTN RAISE TO 12bb (YOUR DECISION)".
 */
export function describeStreetSizes(
  sizes: StreetBetSizes,
  oopPosition: string,
  ipPosition: string,
  added: AddedSize[] = [],
): string {
  const bets = (p: Player) => sizes[p]?.bet ?? sizes.bet;
  const one = (p: Player) => {
    const raise = sizes[p]?.raise ?? sizes.raise;
    return `${bets(p) || "NONE"}${raise ? `; RAISE ${raise}` : "; NO RAISE"}`;
  };
  const [oop, ip] = [one("oop"), one("ip")];
  const base = oop === ip ? oop : `${ipPosition} ${ip} · ${oopPosition} ${oop}`;
  if (added.length === 0) return base;
  const fmt = (n: number) => `${round(n)}bb`;
  const item = (a: AddedSize) => {
    const pos = a.player === "oop" ? oopPosition : ipPosition;
    const what = a.allin
      ? `ALL-IN ${fmt(a.amountBb)}`
      : a.kind === "raise"
        ? `RAISE TO ${fmt(a.amountBb)}`
        : `${a.player === "oop" && !bets("oop") ? "LEAD" : "BET"} ${fmt(a.amountBb)}`;
    return `${pos} ${what}${a.described ? "" : " (YOUR DECISION)"}`;
  };
  return `${base} · ADDED: ${added.map(item).join(", ")}`;
}

/** Pot and to-call at a node (older solvers: the starting pot, nothing to call). */
const nodePot = (n: SolverNode | undefined, startingPotChips: number) => n?.pot ?? startingPotChips;
const nodeToCall = (n: SolverNode | undefined) => n?.to_call ?? 0;

/** A solver node-line entry ("Check", "Bet(275)", "Raise(900)", "AllIn(9750)") as a street action. */
function solverStep(entry: string): { action: StreetStep["action"]; amountBb: number | null } | null {
  const m = /^(Check|Bet|Raise|AllIn)(?:\((\d+)\))?$/.exec(entry);
  if (!m) return null;
  const action = ({ Check: "check", Bet: "bet", Raise: "raise", AllIn: "allin" } as const)[m[1] as "Check"];
  return { action, amountBb: m[2] ? chipsToBb(Number(m[2])) : null };
}

/** Last (and own previous) action of a solver node line, for titles. */
function lastSteps(line: string[], player: Player, spot: ResolvedSpot) {
  const other = player === "oop" ? spot.ipPosition : spot.oopPosition;
  const who = player === spot.heroPlayer ? other : "you";
  const last = line.length ? solverStep(line[line.length - 1]) : null;
  const own = line.length >= 2 ? solverStep(line[line.length - 2]) : null;
  return { last: last && { who, ...last }, own, other };
}

function nodeTitle(line: string[], player: Player, spot: ResolvedSpot): string {
  const pos = player === "oop" ? spot.oopPosition : spot.ipPosition;
  const { last, own, other } = lastSteps(line, player, spot);
  if (line.length > 0 && !last) return `${pos} after ${other} ${line[line.length - 1].toLowerCase()}`;
  return nodeTitleText(pos, last, own);
}

/** Hero-card phrasing of the node where hero acts: "when BB checks" / "when you act first" / "facing BB's 3bb bet". */
function heroSituation(line: string[], player: Player, spot: ResolvedSpot): string {
  if (line.length === 0) return "when you act first";
  const { last, other } = lastSteps(line, player, spot);
  if (!last) return `when ${other} ${line[line.length - 1].toLowerCase()}`;
  return last.action === "check" ? `when ${other} checks` : facingText(other, last.action, last.amountBb);
}

/** Titles for the walked street nodes: villain's last decision, then hero's. */
function streetTitles(line: StreetLine, spot: ResolvedSpot, result: SolverOkResponse): string[] {
  const villainPos = spot.villainPosition;
  const sl = result.street_line;
  const n = line.steps.length;
  const villainTitle = streetNodeTitle(line, n - 1, villainPos, villainPos, sl);
  const heroTitle = streetNodeTitle(line, n, spot.heroPosition, villainPos, sl);
  // The villain node is left out when villain's range was locked.
  return result.nodes.length >= 2 ? [villainTitle, heroTitle] : [heroTitle];
}

/**
 * Sizes the solved tree has beyond its bet sizes: the described street action's sizes that
 * weren't already options, and the raise the solver gives hero facing a bet on a street
 * without raises (so fold / call / raise can be compared).
 */
export function solvedAddedSizes(
  result: SolverOkResponse,
  spot: Pick<ResolvedSpot, "heroPlayer" | "betSizes">,
  line: StreetLine | null,
): AddedSize[] {
  const sl = result.street_line;
  const described = addedStreetSizes(line, sl, spot.heroPlayer);
  if (!line || !sl?.matched) return described;
  const last = line.steps[line.steps.length - 1];
  if (last.action !== "bet" && last.action !== "raise") return described;
  if (described.some((a) => a.player === spot.heroPlayer && a.kind === "raise")) return described;
  const street = (result.tree?.bet_sizes ?? spot.betSizes)[line.street];
  const raise = street[spot.heroPlayer]?.raise ?? street.raise;
  if (raise.split(/,\s*/).some((x) => x.trim() !== "" && x.trim().toLowerCase() !== "a")) return described;
  const node = result.hero_hand ? result.nodes[result.hero_hand.node] : result.nodes[result.nodes.length - 1];
  const r = node?.player === spot.heroPlayer ? node.actions.find((a) => a.action === "Raise") : undefined;
  if (!r) return described;
  return [
    ...described,
    { street: line.street, player: spot.heroPlayer, kind: "raise", allin: false, amountBb: chipsToBb(r.amount), described: false },
  ];
}

export function presentResult(
  result: SolverOkResponse,
  spot: ResolvedSpot,
  assumptions: string[],
  notes: string | null,
  startingPotChips: number,
  extras: Partial<SpotExtras> = {},
): SolveOkPayload {
  const position = (p: Player) => (p === "oop" ? spot.oopPosition : spot.ipPosition);
  const sl = result.street_line;
  const line = extras.street ?? null;
  const matched = !!(sl?.matched && line);
  const titles = matched ? streetTitles(line!, spot, result) : null;
  const added = solvedAddedSizes(result, spot, line);
  // The default flop tree's text names the added sizes itself.
  const treeText = treeChoiceAssumptions(spot, assumptions, result.tree, added);
  const nodes: DisplayNode[] = result.nodes.map((n, i) => ({
    title: titles?.[i] ?? nodeTitle(n.line, n.player, spot),
    player: n.player,
    position: position(n.player),
    isHero: n.player === spot.heroPlayer,
    actions: n.actions.map((a) => presentAction(a, nodePot(n, startingPotChips), nodeToCall(n))),
  }));
  const hh = result.hero_hand;
  const heroNode = hh ? result.nodes[hh.node] : undefined;
  const n = result.narrowing;
  const narrowing: DisplayNarrowing | null =
    n && n.narrowed && n.ranges
      ? {
          players: {
            oop: {
              position: spot.oopPosition,
              combosBefore: n.ranges.oop.combos_before,
              combosAfter: n.ranges.oop.combos_after,
              classes: n.ranges.oop.classes,
              range: n.oop_range ?? "",
              lineProbability: n.ranges.oop.line_probability ?? null,
              blended: n.ranges.oop.blended ?? false,
            },
            ip: {
              position: spot.ipPosition,
              combosBefore: n.ranges.ip.combos_before,
              combosAfter: n.ranges.ip.combos_after,
              classes: n.ranges.ip.classes,
              range: n.ip_range ?? "",
              lineProbability: n.ranges.ip.line_probability ?? null,
              blended: n.ranges.ip.blended ?? false,
            },
          },
          flopSolveMs: n.solve_ms,
          iterations: n.iterations,
          exploitabilityPct: n.exploitability_pct,
        }
      : null;
  const situation = heroNode ? heroSituation(heroNode.line, heroNode.player, spot) : "";
  const decision = matched
    ? decisionText(line!, spot.villainPosition, sl)
    : situation === "when you act first"
      ? "acting first"
      : situation.replace(/^when /, "after ");
  const vr = sl?.villain_range;
  const heroActions = hh
    ? markBest(hh.actions.map((a) => presentAction(a, nodePot(heroNode, startingPotChips), nodeToCall(heroNode))))
    : [];
  return {
    status: "ok",
    spot: {
      board: spot.board,
      street: spot.street,
      potType: spot.potType,
      heroPosition: spot.heroPosition,
      villainPosition: spot.villainPosition,
      oopPosition: spot.oopPosition,
      ipPosition: spot.ipPosition,
      heroPlayer: spot.heroPlayer,
      heroHand: spot.heroHand,
      potBb: spot.potBb,
      effectiveStackBb: spot.effectiveStackBb,
      oopRange: spot.oopRange,
      ipRange: spot.ipRange,
      // The tree the solver actually solved (a fallback or auto-simplified one), else the request's.
      betSizes: result.tree?.bet_sizes ?? spot.betSizes,
      addedSizes: added,
    },
    assumptions: [
      ...treeText,
      ...narrowingAssumptions(n, spot.line, spot.heroPlayer),
      ...streetAssumptions(sl, line, spot.heroPlayer, !!extras.villainHand, spot.flopTreeSeats ? null : added),
    ],
    notes: notes && notes.trim() ? notes.trim() : null,
    players: {
      oop: { position: spot.oopPosition, equity: result.players.oop.equity, evBb: round(chipsToBb(result.players.oop.ev)) },
      ip: { position: spot.ipPosition, equity: result.players.ip.equity, evBb: round(chipsToBb(result.players.ip.ev)) },
    },
    nodes,
    heroHand: hh
      ? {
          hand: hh.hand,
          nodeTitle: nodes[hh.node]?.title ?? "",
          situation,
          decision,
          streetAction: matched ? describeStreetLine(line!, spot.villainPosition, sl) : null,
          equity: hh.equity,
          evBb: round(chipsToBb(hh.ev)),
          actions: heroActions,
          verdict: verdict(heroActions, chipsToBb(nodePot(heroNode, startingPotChips))),
        }
      : null,
    narrowing,
    streetLine: sl
      ? {
          matched,
          villainRange:
            matched && vr
              ? {
                  position: spot.villainPosition,
                  combosBefore: vr.combos_before,
                  combosAfter: vr.combos_after,
                  classes: vr.classes,
                }
              : null,
        }
      : null,
    villainHand: extras.villainHand?.label ?? null,
    stats: {
      exploitabilityPct: result.exploitability_pct,
      targetExploitabilityPct: spot.targetExploitabilityPct,
      iterations: result.iterations,
      solveMs: result.solve_ms,
      memoryMb: result.memory_mb,
      compressed: result.compressed,
    },
  };
}
