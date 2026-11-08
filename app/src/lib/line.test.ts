import { describe, expect, it } from "vitest";
import { applyDefaults } from "./defaults";
import {
  describeLine,
  NO_LINE_ASSUMPTION,
  narrowingAssumptions,
  rareLineAssumption,
  POT_TOO_SMALL_NO_LINE,
  type SpotLine,
  USER_RANGES_NO_LINE,
} from "./line";
import { mockExtraction } from "./mock-llm";
import { presentResult } from "./present";
import { prepareSolve } from "./request";
import type { Action } from "./schema";
import { extraction } from "./test-helpers";
import type { SolverNarrowing, SolverOkResponse } from "./types";

const act = (street: Action["street"], actor: Action["actor"], action: Action["action"], amount: number | null = null): Action => ({
  street,
  actor,
  action,
  amount,
});

// The user's spot: open 15, 3-bet 60, flop villain checks, hero bets 125, villain calls; turn.
const USER_ACTIONS: Action[] = [
  act("preflop", "hero", "open", 15),
  act("preflop", "villain", "3bet", 60),
  act("preflop", "hero", "call"),
  act("flop", "villain", "check"),
  act("flop", "hero", "raise", 125),
  act("flop", "villain", "call"),
  act("turn", "villain", "check"),
];
const userSpot = (overrides: Parameters<typeof extraction>[0] = {}) =>
  extraction({ num_players: 2, street: "turn", board: "Qh2c7h8h", hero_hand: "2h2s", amount_unit: "chips", actions: USER_ACTIONS, ...overrides });

function prepared(x: ReturnType<typeof extraction>) {
  const r = prepareSolve(x);
  if (!r.ok) throw new Error(r.error.reason);
  return r;
}

describe("line mapping (history -> solver line)", () => {
  it("sends a checked-through street OOP first even when hero's check was listed first", () => {
    const { request } = prepared(
      userSpot({
        street: "river",
        board: "Qh2c7h8h3d",
        actions: [...USER_ACTIONS.slice(0, 6), act("turn", "hero", "check"), act("turn", "villain", "check"), act("river", "villain", "check")],
      }),
    );
    expect(request.line?.filter((a) => a.street === "turn")).toEqual([
      { street: "turn", player: "oop", action: "check", amount_chips: null },
      { street: "turn", player: "ip", action: "check", amount_chips: null },
    ]);
  });

  it("maps the user's flop line to OOP/IP and chips, with the flop pot and stack", () => {
    const { request, assumptions } = prepared(userSpot());
    expect(request.hero.player).toBe("ip");
    expect(request.line).toEqual([
      { street: "flop", player: "oop", action: "check", amount_chips: null },
      { street: "flop", player: "ip", action: "bet", amount_chips: 2500 },
      { street: "flop", player: "oop", action: "call", amount_chips: null },
    ]);
    expect(request.flop_pot).toBe(2450);
    expect(request.flop_stack).toBe(8800);
    expect(request.starting_pot).toBe(2450 + 2 * 2500);
    expect(request.effective_stack).toBe(8800 - 2500);
    expect(assumptions).not.toContain(NO_LINE_ASSUMPTION);
  });

  it("fills in an implied call the extraction left out", () => {
    const { request } = prepared(userSpot({ actions: USER_ACTIONS.filter((a) => !(a.street === "flop" && a.action === "call")) }));
    expect(request.line?.at(-1)).toEqual({ street: "flop", player: "oop", action: "call", amount_chips: null });
  });

  it("river spot: a street with no action given is sent as two checks", () => {
    const flopOnly = USER_ACTIONS.filter((a) => a.street !== "turn");
    const { request, assumptions } = prepared(userSpot({ street: "river", board: "Qh2c7h8h3d", actions: flopOnly }));
    expect(request.line).toEqual([
      { street: "flop", player: "oop", action: "check", amount_chips: null },
      { street: "flop", player: "ip", action: "bet", amount_chips: 2500 },
      { street: "flop", player: "oop", action: "call", amount_chips: null },
      { street: "turn", player: "oop", action: "check", amount_chips: null },
      { street: "turn", player: "ip", action: "check", amount_chips: null },
    ]);
    expect(assumptions).toContain("Assumed the turn checked through");
  });

  it("river spot: a lone check on the turn was checked behind", () => {
    const { request } = prepared(userSpot({ street: "river", board: "Qh2c7h8h3d" }));
    expect(request.line?.slice(3)).toEqual([
      { street: "turn", player: "oop", action: "check", amount_chips: null },
      { street: "turn", player: "ip", action: "check", amount_chips: null },
    ]);
  });

  it("a raise facing a bet is a raise to the stated total", () => {
    const actions = [
      act("flop", "villain", "check"),
      act("flop", "hero", "bet", 3),
      act("flop", "villain", "raise", 9),
      act("flop", "hero", "call"),
    ];
    const { request } = prepared(extraction({ board: "Td9d6hQc", amount_unit: "bb", actions }));
    expect(request.line?.map((a) => [a.player, a.action, a.amount_chips])).toEqual([
      ["oop", "check", null],
      ["ip", "bet", 300],
      ["oop", "raise", 900],
      ["ip", "call", null],
    ]);
    expect(request.flop_pot).toBe(550);
    expect(request.starting_pot).toBe(550 + 1800);
  });

  it("a stated pot keeps the line; the flop pot is the pot minus the earlier bets", () => {
    const { request } = prepared(userSpot({ pot_bb: 80 }));
    expect(request.starting_pot).toBe(8000);
    expect(request.flop_pot).toBe(8000 - 5000);
    expect(request.line).toHaveLength(3);
  });

  it("a stated pot that is the flop pot (bets came after it) gets the later bets added", () => {
    // Flop pot 24.5bb from the preflop line; hero bet 25bb on the flop and was called.
    const { request, spot, assumptions } = prepared(userSpot({ pot_bb: 24.5 }));
    expect(spot.potBb).toBe(74.5);
    expect(request.flop_pot).toBe(2450);
    expect(request.line).toBeDefined();
    expect(assumptions).toContain("Read your 24.5bb pot as the flop pot (bets came after it): 74.5bb at the start of the turn");
  });

  it("a stated pot smaller than the earlier bets skips narrowing, visibly", () => {
    const { request, assumptions } = prepared(userSpot({ pot_bb: 40 }));
    expect(request.line).toBeUndefined();
    expect(assumptions).toContain(POT_TOO_SMALL_NO_LINE);
  });

  it("user-given ranges are not narrowed", () => {
    const { request, assumptions } = prepared(userSpot({ oop_range: "QQ+" }));
    expect(request.line).toBeUndefined();
    expect(assumptions).toContain(USER_RANGES_NO_LINE);
  });

  it("turn spot with no earlier action: full preflop ranges, said so", () => {
    for (const x of [
      extraction({ board: "Td9d6hQc" }),
      extraction({ board: "Td9d6hQc2s", amount_unit: "chips", actions: USER_ACTIONS.slice(0, 3) }),
    ]) {
      const { request, assumptions } = prepared(x);
      expect(request.line).toBeUndefined();
      expect(request.flop_pot).toBeUndefined();
      expect(assumptions).toContain(NO_LINE_ASSUMPTION);
    }
  });

  it("flop spots are unchanged: no line, no narrowing assumption", () => {
    const { spot, assumptions } = applyDefaults(extraction({ board: "Td9d6h" }));
    expect(spot.line).toBeNull();
    expect(assumptions).not.toContain(NO_LINE_ASSUMPTION);
    const { request } = prepared(extraction({ board: "Td9d6h" }));
    expect(Object.keys(request)).not.toContain("line");
  });

  it("the mock LLM fixture produces a line", () => {
    const { request } = prepared(mockExtraction("BTN vs BB, turn Td9d6hQc, I have AhKh. Flop: villain checks, I bet 3bb, he calls."));
    expect(request.line?.map((a) => a.action)).toEqual(["check", "bet", "call"]);
    expect(request.line?.[1].amount_chips).toBe(300);
  });
});

const LINE: SpotLine = {
  flopPotBb: 24.5,
  flopStackBb: 88,
  streets: [
    {
      street: "flop",
      steps: [
        { actor: "villain", action: "check", amountBb: null },
        { actor: "hero", action: "bet", amountBb: 25 },
        { actor: "villain", action: "call", amountBb: null },
      ],
    },
    { street: "turn", steps: null },
  ],
};

const NARROWED: SolverNarrowing = {
  narrowed: true,
  reason: null,
  oop_range: "QQ+,AQs:0.5",
  ip_range: "22,AKs",
  ranges: {
    oop: { combos_before: 80, combos_after: 30.5, classes: [{ hand: "QQ", combos: 3, weight: 1 }] },
    ip: { combos_before: 200, combos_after: 150, classes: [{ hand: "22", combos: 3, weight: 1 }] },
  },
  sizes: [{ street: "flop", player: "ip", action: "bet", requested: 2500, used: 2500, size: "102.04%", added: true }],
  line_bets: "33%, 75%",
  line_raises: null,
  hero_weight: 1,
  hero_floored: false,
  iterations: 120,
  exploitability_pct: 0.9,
  memory_mb: 80,
  solve_ms: 1900,
};

describe("narrowing assumptions", () => {
  it("describes the line street by street", () => {
    expect(describeLine(LINE)).toBe("villain checked, you bet 25bb, villain called on the flop; checked through on the turn");
  });

  it("narrowed: one line naming the line; nothing else when sizes matched", () => {
    const out = narrowingAssumptions(NARROWED, LINE, "ip");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(
      "Ranges narrowed by a simplified flop solve of your line (villain checked, you bet 25bb, villain called on the flop; checked through on the turn). " +
        "Flop model: both players bet 33%/75%, no raises; your 25bb bet (from your line) added. " +
        "Turn model: both players bet 33%/75%, no raises. Later streets: one bet size, no raises or leads into the last bettor.",
    );
  });

  it("with an IP preflop raiser the flop model says the OOP caller doesn't lead", () => {
    expect(narrowingAssumptions({ ...NARROWED, line_aggressor: "ip" }, LINE, "ip")[0]).toContain(
      "Flop model: you bet 33%/75%, villain doesn't lead, no raises; your 25bb bet (from your line) added. Turn model: both players bet 33%/75%, no raises.",
    );
    const heroOop: SpotLine = {
      ...LINE,
      streets: [
        {
          street: "flop",
          steps: [
            { actor: "hero", action: "check", amountBb: null },
            { actor: "villain", action: "bet", amountBb: 25 },
            { actor: "hero", action: "call", amountBb: null },
          ],
        },
      ],
    };
    const oopSizes = [{ ...NARROWED.sizes[0], player: "ip" as const }];
    expect(narrowingAssumptions({ ...NARROWED, sizes: oopSizes, line_aggressor: "ip" }, heroOop, "oop")[0]).toContain(
      "Flop model: villain bets 33%/75%, you don't lead, no raises; villain's 25bb bet (from your line) added.",
    );
  });

  it("a lead or raise the flop model excludes is named as added, never contradicted", () => {
    // BB (villain, OOP) leads 4bb into the IP preflop raiser, hero calls.
    const lead: SpotLine = {
      ...LINE,
      streets: [
        {
          street: "flop",
          steps: [
            { actor: "villain", action: "bet", amountBb: 4 },
            { actor: "hero", action: "call", amountBb: null },
          ],
        },
      ],
    };
    const leadSizes = [{ street: "flop", player: "oop", action: "bet", requested: 400, used: 400, size: "72.73%", added: true }] as const;
    const out = narrowingAssumptions({ ...NARROWED, sizes: [...leadSizes], line_aggressor: "ip" }, lead, "ip")[0];
    expect(out).toContain("Flop model: you bet 33%/75%, no raises; villain's 4bb lead (from your line) added.");
    expect(out).not.toContain("doesn't lead");
    // A check-raise when the flop model has no raises.
    const xr: SpotLine = {
      ...LINE,
      streets: [
        {
          street: "flop",
          steps: [
            { actor: "villain", action: "check", amountBb: null },
            { actor: "hero", action: "bet", amountBb: 2 },
            { actor: "villain", action: "raise", amountBb: 6 },
            { actor: "hero", action: "call", amountBb: null },
          ],
        },
      ],
    };
    const xrSizes = [{ street: "flop", player: "oop", action: "raise", requested: 600, used: 600, size: "3x", added: true }] as const;
    const out2 = narrowingAssumptions({ ...NARROWED, sizes: [...xrSizes], line_aggressor: "ip" }, xr, "ip")[0];
    expect(out2).toContain("Flop model: you bet 33%/75%, villain doesn't lead, no other raises; villain's raise to 6bb (from your line) added.");
  });

  it("names whose sizes were added; a default-sized bet isn't added", () => {
    const sizes = [
      { street: "flop", player: "ip", action: "bet", requested: 600, used: 600, size: "75%", added: false },
      { street: "flop", player: "oop", action: "raise", requested: 1800, used: 1800, size: "3x", added: true },
    ] as const;
    const out = narrowingAssumptions({ ...NARROWED, sizes: [...sizes], line_raises: "3x" }, LINE, "ip");
    expect(out[0]).toContain("Flop model: both players bet 33%/75% and raise 3x; villain's raise to 18bb (from your line) added.");
    expect(out[0]).not.toContain("6bb bet added");
  });

  it("reports rounded sizes and a floored hero hand", () => {
    const out = narrowingAssumptions(
      { ...NARROWED, hero_floored: true, sizes: [{ ...NARROWED.sizes[0], used: 2450 }] },
      LINE,
      "ip",
    );
    expect(out).toContain("Your 25bb flop bet was solved as 24.5bb (the closest size the flop tree allows)");
    expect(out.some((a) => a.startsWith("Your hand almost never takes this line"))).toBe(true);
  });

  it("rare lines: an assumption per blended player, villain first", () => {
    const ranges = {
      oop: { ...NARROWED.ranges!.oop, line_probability: 0.0249, blended: true, alpha: 0.5 },
      ip: { ...NARROWED.ranges!.ip, line_probability: 0.0001, blended: true, alpha: 0.3 },
    };
    const out = narrowingAssumptions({ ...NARROWED, ranges, rare_line_threshold: 0.05 }, LINE, "ip");
    expect(out.slice(1)).toEqual([
      "Villain's line is unusual at equilibrium (~2% of his range) — his range is a rough estimate blended toward his starting range.",
      "Your line is unusual at equilibrium (under 1% of your range) — your range is a rough estimate blended toward your starting range.",
    ]);
    // Common lines (and older solvers without the fields) add nothing.
    const common = { oop: { ...ranges.oop, line_probability: 0.4, blended: false, alpha: 1 }, ip: NARROWED.ranges!.ip };
    expect(narrowingAssumptions({ ...NARROWED, ranges: common }, LINE, "ip")).toHaveLength(1);
    expect(rareLineAssumption(false, 0.034)).toContain("(~3% of his range)");
  });

  it("presentResult passes the line fit to the narrowed ranges", () => {
    const r = prepared(userSpot());
    const ranges = { oop: { ...NARROWED.ranges!.oop, line_probability: 0.02, blended: true, alpha: 0.4 }, ip: NARROWED.ranges!.ip };
    const solver: SolverOkResponse = {
      status: "ok",
      exploitability_pct: 0.4,
      iterations: 100,
      solve_ms: 3000,
      memory_mb: 50,
      compressed: false,
      players: { oop: { equity: 0.4, ev: 3000 }, ip: { equity: 0.6, ev: 4450 } },
      nodes: [],
      hero_hand: null,
      narrowing: { ...NARROWED, ranges },
    };
    const p = presentResult(solver, r.spot, r.assumptions, null, r.request.starting_pot);
    expect(p.narrowing?.players.oop).toMatchObject({ lineProbability: 0.02, blended: true });
    expect(p.narrowing?.players.ip).toMatchObject({ lineProbability: null, blended: false });
    expect(p.assumptions.at(-1)).toMatch(/^Villain's line is unusual at equilibrium \(~2% of his range\)/);
  });

  it("skipped: says why and that full ranges were used", () => {
    const out = narrowingAssumptions(
      { ...NARROWED, narrowed: false, reason: "the line has a fold on the flop", ranges: null },
      LINE,
      "ip",
    );
    expect(out).toEqual(["Ranges not narrowed (the line has a fold on the flop): full preflop ranges used"]);
  });

  it("nothing when no line was sent or the solver didn't report narrowing", () => {
    expect(narrowingAssumptions(undefined, LINE, "ip")).toEqual([]);
    expect(narrowingAssumptions(NARROWED, null, "ip")).toEqual([]);
  });

  it("presentResult shows narrowed ranges and appends the assumption", () => {
    const r = prepared(userSpot());
    const solver: SolverOkResponse = {
      status: "ok",
      exploitability_pct: 0.4,
      iterations: 100,
      solve_ms: 3000,
      memory_mb: 50,
      compressed: false,
      players: { oop: { equity: 0.4, ev: 3000 }, ip: { equity: 0.6, ev: 4450 } },
      nodes: [],
      hero_hand: null,
      narrowing: NARROWED,
    };
    const p = presentResult(solver, r.spot, r.assumptions, null, r.request.starting_pot);
    expect(p.narrowing?.players.oop).toMatchObject({ position: "BB", combosBefore: 80, combosAfter: 30.5, range: "QQ+,AQs:0.5" });
    expect(p.narrowing?.flopSolveMs).toBe(1900);
    expect(p.assumptions.at(-1)).toMatch(/^Ranges narrowed/);

    const plain = presentResult({ ...solver, narrowing: undefined }, r.spot, r.assumptions, null, r.request.starting_pot);
    expect(plain.narrowing).toBeNull();
    expect(plain.assumptions).toEqual(r.assumptions);
  });
});
