// Turns a solver result (chips) into the /api/solve response the UI renders
// (big blinds, % of pot, position labels). Pure; the UI does no unit math.
import type { ResolvedSpot } from "./defaults";
import { chipsToBb } from "./poker";
import type { CantSolveResponse, HeroAction, Player, SolverOkResponse } from "./types";

export type DisplayAction = {
  action: HeroAction["action"];
  /** e.g. "Check", "Bet 2.75bb", "All-in 97.5bb". */
  label: string;
  amountBb: number;
  /** Size as % of the pot at the node; null for Check/Call/Fold/All-in. */
  potPct: number | null;
  frequency: number;
  topHands: string[];
};

export type DisplayNode = {
  /** e.g. "BB acts first" or "BTN after BB checks". */
  title: string;
  player: Player;
  position: string;
  isHero: boolean;
  actions: DisplayAction[];
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
    actions: DisplayAction[];
  } | null;
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

export function presentAction(a: HeroAction & { top_hands?: string[] }, potChips: number): DisplayAction {
  const amountBb = chipsToBb(a.amount);
  const sized = a.action === "Bet" || a.action === "Raise" || a.action === "AllIn";
  const name = a.action === "AllIn" ? "All-in" : a.action;
  return {
    action: a.action,
    label: sized ? `${name} ${fmtBb(amountBb)}` : name,
    amountBb,
    potPct: sized && a.action !== "AllIn" && potChips > 0 ? round((a.amount / potChips) * 100, 0) : null,
    frequency: a.frequency,
    topHands: a.top_hands ?? [],
  };
}

function nodeTitle(line: string[], player: Player, spot: ResolvedSpot): string {
  const pos = player === "oop" ? spot.oopPosition : spot.ipPosition;
  if (line.length === 0) return `${pos} acts first`;
  const other = player === "oop" ? spot.ipPosition : spot.oopPosition;
  const prev = line[line.length - 1].toLowerCase();
  return `${pos} after ${other} ${prev === "check" ? "checks" : prev}`;
}

export function presentResult(
  result: SolverOkResponse,
  spot: ResolvedSpot,
  assumptions: string[],
  notes: string | null,
  startingPotChips: number,
): SolveOkPayload {
  const position = (p: Player) => (p === "oop" ? spot.oopPosition : spot.ipPosition);
  const nodes: DisplayNode[] = result.nodes.map((n) => ({
    title: nodeTitle(n.line, n.player, spot),
    player: n.player,
    position: position(n.player),
    isHero: n.player === spot.heroPlayer,
    actions: n.actions.map((a) => presentAction(a, startingPotChips)),
  }));
  const hh = result.hero_hand;
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
      betSizes: spot.betSizes,
    },
    assumptions,
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
          equity: hh.equity,
          evBb: round(chipsToBb(hh.ev)),
          actions: hh.actions.map((a) => presentAction(a, startingPotChips)),
        }
      : null,
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
