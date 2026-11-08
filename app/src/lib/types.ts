// Shared types for the solver HTTP contract (SPEC §7) and the "can't solve"
// shape (SPEC §6). Amounts on the wire are integer chips (1bb = 100 chips).

export type Player = "oop" | "ip";

export type StreetBetSizes = {
  bet: string;
  raise: string;
  /** Per-player overrides of `bet` / `raise`. */
  oop?: { bet?: string; raise?: string };
  ip?: { bet?: string; raise?: string };
  /** Turn/river: OOP's lead sizes after calling the last street's bet ("" = no leads). */
  donk?: string;
};

export type BetSizesByStreet = {
  flop: StreetBetSizes;
  turn: StreetBetSizes;
  river: StreetBetSizes;
};

/** One action of the earlier-street line (SPEC §7 "line"), or of `street_actions` (any street). */
export type SolverLineAction = {
  street: "flop" | "turn" | "river";
  player: Player;
  action: "check" | "bet" | "call" | "raise" | "fold" | "allin";
  /** Chips. Bet size for a bet, raise-to total for the street for a raise; null otherwise. */
  amount_chips: number | null;
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
  /**
   * Turn/river spots: the betting on earlier postflop streets. The solver first narrows
   * both ranges with a simplified flop solve of this line (one request, one queue slot).
   */
  line?: SolverLineAction[];
  /** Chips at the start of the flop; sent with `line`. */
  flop_pot?: number;
  flop_stack?: number;
  /**
   * Action on the current street before hero's decision. The solver adds its sizes to
   * the actor's options, walks to hero's decision and reports that node.
   */
  street_actions?: SolverLineAction[];
  /** Villain's known hand ("7c2d" or a class like "72o"): villain's range is exactly that. */
  villain_hand?: string;
  /** Preflop raiser's seat; line narrowing then has an OOP caller not lead the flop. */
  preflop_aggressor?: Player;
  /** Simpler trees the solver falls back to when `bet_sizes` is estimated too slow. */
  bet_size_fallbacks?: BetSizesByStreet[];
};

/** Which tree the solver solved (SPEC §7 "Tree budget"). */
export type SolverTreeChoice = {
  /** Index into [bet_sizes, ...bet_size_fallbacks, ...auto-simplified]. */
  index: number;
  /** Trees the request gave; index >= given means auto-simplified. */
  given: number;
  auto?: "no_raises" | "one_size";
  bet_sizes: BetSizesByStreet;
  estimated_secs: number;
  raw_mb: number;
  over_budget: boolean;
};

/** A hand class still in a narrowed range. */
export type ClassWeight = {
  hand: string;
  /** Weighted combos left on the current board. */
  combos: number;
  /** Average weight of the class's live combos, in [0, 1]. */
  weight: number;
};

export type RangeSummary = {
  combos_before: number;
  combos_after: number;
  /** Most combos first. */
  classes: ClassWeight[];
};

/** A player's stage-1 narrowed range, with how well the range fits the line (SPEC §7 "Rare lines"). */
export type NarrowedRangeSummary = RangeSummary & {
  /** Share of the player's starting range that takes the line in the flop solve, in [0, 1]. */
  line_probability?: number;
  /** The line was rarer than `rare_line_threshold`: the range is blended toward the starting range. */
  blended?: boolean;
  /** Share of the blend taken from the narrowed range (1 when not blended). */
  alpha?: number;
};

export type LineSize = {
  street: string;
  player: Player;
  action: "bet" | "raise" | "allin";
  /** Chips asked for. */
  requested: number;
  /** Chips the flop solve actually used; null if it never got there. */
  used: number | null;
  /** Size string given to the solver, e.g. "102.04%" or "3x". */
  size: string;
  /** Added to the acting player's flop-solve sizes (false when it equals a default). */
  added: boolean;
};

/** Stage-1 result, present when the request had a `line`. */
export type SolverNarrowing = {
  narrowed: boolean;
  /** Why not (when narrowed is false). */
  reason: string | null;
  oop_range: string | null;
  ip_range: string | null;
  ranges: Record<Player, NarrowedRangeSummary> | null;
  sizes: LineSize[];
  /** Bet / raise sizes both players had on the line's streets in the flop solve ("33%, 75%"; null raises = none). */
  line_bets: string | null;
  line_raises: string | null;
  /** Preflop raiser stage 1 was built around; when IP, OOP had no flop leads. */
  line_aggressor?: Player;
  hero_weight: number | null;
  hero_floored: boolean;
  iterations: number | null;
  /** Percent of the flop pot. */
  exploitability_pct: number | null;
  memory_mb: number | null;
  /** Stage-1 time; the response's solve_ms covers both stages. */
  solve_ms: number;
  /** Line probability below which a range is blended (0 = never). Older solvers omit it. */
  rare_line_threshold?: number | null;
};

export type SolverActionName = "Fold" | "Check" | "Call" | "Bet" | "Raise" | "AllIn";

export type HeroAction = {
  action: SolverActionName;
  /** Chips; 0 for Fold/Check/Call. */
  amount: number;
  frequency: number;
  /** Hero hand's EV of this action in chips (fold = 0). Hero actions only. */
  ev?: number;
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
  /** Chips in the middle at the node, current-street bets included. */
  pot?: number;
  /** Chips the acting player must add to call (0 when not facing a bet). */
  to_call?: number;
};

/** Result of walking `street_actions` (present when the request had them). */
export type SolverStreetLine = {
  /** True: `nodes`/`hero_hand`/`players` are at hero's decision after the street actions. */
  matched: boolean;
  /** Why not (when matched is false); the start-of-street nodes are reported. */
  reason: string | null;
  sizes: LineSize[];
  /** Villain's whole range was forced to take the line (known hand, or `villain_rare`). */
  villain_locked: boolean;
  /** The solver's villain almost never took the line, so it was re-solved locked. */
  villain_rare: boolean;
  /** Villain's range at hero's decision (combos_before = at the start of the street). */
  villain_range: RangeSummary | null;
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
  narrowing?: SolverNarrowing;
  street_line?: SolverStreetLine;
  tree?: SolverTreeChoice;
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
