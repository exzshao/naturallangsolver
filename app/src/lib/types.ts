// Shared types for the solver HTTP contract (SPEC §7) and the "can't solve"
// shape (SPEC §6). Amounts on the wire are integer chips (1bb = 100 chips).

export type Player = "oop" | "ip";

export type StreetBetSizes = {
  bet: string;
  raise: string;
};

export type BetSizesByStreet = {
  flop: StreetBetSizes;
  turn: StreetBetSizes;
  river: StreetBetSizes;
};

export type SolverRequest = {
  board: string;
  oop_range: string;
  ip_range: string;
  /** Chips (1bb = 100). The solver rounds floats. */
  starting_pot: number;
  effective_stack: number;
  bet_sizes: BetSizesByStreet;
  hero: { player: Player; hand: string | null };
  /** Optional; the solver defaults to (and caps at) its MAX_ITERATIONS. */
  max_iterations?: number;
  /** Percent of starting_pot. Optional; the solver defaults to 0.5. */
  target_exploitability_pct?: number;
};

export type SolverActionName = "Fold" | "Check" | "Call" | "Bet" | "Raise" | "AllIn";

export type HeroAction = {
  action: SolverActionName;
  /** Chips; 0 for Fold/Check/Call. */
  amount: number;
  frequency: number;
};

/** A hand class ("KK", "KQs", "KQo") and how often its live combos take the action. */
export type HandClass = {
  hand: string;
  /** Weighted average over the class's combos, in [0, 1]. */
  frequency: number;
};

export type SolverAction = HeroAction & {
  /** Class names of `top_classes`, same order (kept for older clients). */
  top_hands: string[];
  /** Up to 6 classes, ordered by how often they take this action (ties: range weight sent in); may be empty. */
  top_classes: HandClass[];
};

export type SolverNode = {
  line: string[];
  player: Player;
  actions: SolverAction[];
};

export type SolverOkResponse = {
  status: "ok";
  /** Percent of starting pot. */
  exploitability_pct: number;
  iterations: number;
  solve_ms: number;
  memory_mb: number;
  compressed: boolean;
  /** Range-average equity in [0, 1] and EV in chips. */
  players: Record<Player, { equity: number; ev: number }>;
  nodes: SolverNode[];
  hero_hand: {
    hand: string;
    /** Index into `nodes` where hero acts. */
    node: number;
    equity: number;
    ev: number;
    actions: HeroAction[];
  } | null;
};

export const CANT_SOLVE_REASONS = [
  "NOT_POKER",
  "INVALID_REQUEST",
  "PREFLOP",
  "MULTIWAY",
  "INVALID_BOARD",
  "INVALID_RANGE",
  "INVALID_BET_SIZES",
  "INVALID_STACKS",
  "TREE_TOO_LARGE",
  "TIMEOUT",
  "SOLVER_BUSY",
  "RATE_LIMITED",
  "LLM_UNAVAILABLE",
  "SOLVER_UNAVAILABLE",
  "INTERNAL",
] as const;

export type CantSolveReason = (typeof CANT_SOLVE_REASONS)[number];

export type CantSolveResponse = {
  status: "cant_solve";
  reason: CantSolveReason;
  message: string;
};

export type SolverResponse = SolverOkResponse | CantSolveResponse;
