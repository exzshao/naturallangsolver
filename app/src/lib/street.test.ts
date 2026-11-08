import { describe, expect, it } from "vitest";
import { mockExtraction } from "./mock-llm";
import { describeStreetSizes, markBest, presentAction, presentResult } from "./present";
import { prepareSolve, villainKnownAssumption } from "./request";
import type { Action, Extraction } from "./schema";
import {
  currentStreetLine,
  decisionText,
  describeStreetLine,
  type StreetLine,
  streetAssumptions,
  type StreetSpot,
  toSolverStreetActions,
} from "./street";
import { extraction } from "./test-helpers";
import type { SolverOkResponse, SolverStreetLine } from "./types";
import { validateExtraction } from "./validate";
import { readVillainHand } from "./villain";

const act = (
  street: Action["street"],
  actor: Action["actor"],
  action: Action["action"],
  amount: number | null = null,
  pot_pct: number | null = null,
): Action => ({ street, actor, action, amount, pot_pct });

const FLOP_IP: StreetSpot = { street: "flop", heroPlayer: "ip", potBb: 5.5, effectiveStackBb: 97.5 };
const FLOP_OOP: StreetSpot = { ...FLOP_IP, heroPlayer: "oop" };
type Units = Pick<Extraction, "amount_unit" | "big_blind_size">;
const bb: Units = { amount_unit: "bb", big_blind_size: null };

function lineOf(actions: Action[], spot = FLOP_IP, units: Units = bb) {
  return currentStreetLine({ ...units, actions }, spot);
}

describe("currentStreetLine", () => {
  it("sizes a lead given as % pot", () => {
    const { line, assumptions } = lineOf([act("flop", "villain", "bet", null, 75)]);
    expect(line).toEqual({ street: "flop", steps: [{ actor: "villain", action: "bet", amountBb: 4.125 }] });
    expect(assumptions).toEqual([]);
  });

  it("a shove is all-in for the effective stack; so is a bet of the whole stack", () => {
    expect(lineOf([act("flop", "villain", "allin")]).line?.steps).toEqual([
      { actor: "villain", action: "allin", amountBb: 97.5 },
    ]);
    expect(lineOf([act("flop", "villain", "bet", 120)]).line?.steps[0].action).toBe("allin");
  });

  it("I bet, he raises to 30: hero IP gets the implied villain check; raise-to in bb", () => {
    const { line, assumptions } = lineOf([act("flop", "hero", "bet", 4), act("flop", "villain", "raise", 30)]);
    expect(line?.steps).toEqual([
      { actor: "villain", action: "check", amountBb: null },
      { actor: "hero", action: "bet", amountBb: 4 },
      { actor: "villain", action: "raise", amountBb: 30 },
    ]);
    expect(assumptions).toEqual(["Assumed villain checked first on the flop"]);
  });

  it("chip amounts use the big blind; a bet facing a bet is a raise", () => {
    const { line } = lineOf(
      [act("flop", "villain", "check"), act("flop", "hero", "bet", 20), act("flop", "villain", "bet", 60)],
      FLOP_IP,
      { amount_unit: "chips", big_blind_size: 2 },
    );
    expect(line?.steps.map((s) => [s.action, s.amountBb])).toEqual([
      ["check", null],
      ["bet", 10],
      ["raise", 30],
    ]);
  });

  it("hero OOP facing an IP bet: hero's check is filled in", () => {
    const { line, assumptions } = lineOf([act("flop", "villain", "bet", null, 50)], FLOP_OOP);
    expect(line?.steps).toEqual([
      { actor: "hero", action: "check", amountBb: null },
      { actor: "villain", action: "bet", amountBb: 2.75 },
    ]);
    expect(assumptions).toEqual(["Assumed you checked first on the flop"]);
  });

  it("drops hero's trailing decision ('should I call?') and checks to me is a check", () => {
    const { line, assumptions } = lineOf([act("flop", "villain", "check"), act("flop", "hero", "call")]);
    expect(line?.steps).toEqual([{ actor: "villain", action: "check", amountBb: null }]);
    expect(assumptions).toEqual(["Treated your call on the flop as the decision you're asking about"]);
    expect(lineOf([act("flop", "hero", "bet", 3)]).line).toBeNull();
  });

  it("ignores other streets and missing sizes get half pot / 3x", () => {
    expect(lineOf([act("preflop", "hero", "open", 2.5), act("turn", "villain", "bet", 5)]).line).toBeNull();
    const { line, assumptions } = lineOf([act("flop", "villain", "bet"), act("flop", "hero", "raise"), act("flop", "villain", "raise")]);
    expect(line?.steps.map((s) => s.amountBb)).toEqual([2.75, 8.25, 24.75]);
    expect(assumptions).toHaveLength(3);
  });

  it("can't-use cases fall back with a reason", () => {
    const cases: [Action[], string][] = [
      [[act("flop", "villain", "bet", 3), act("flop", "hero", "call"), act("flop", "villain", "check")], "a call ends the street"],
      [[act("flop", "villain", "check"), act("flop", "hero", "check"), act("flop", "villain", "bet", 3)], "both players checked"],
      [[act("flop", "villain", "bet", 3), act("flop", "villain", "bet", 9)], "out of turn"],
      [[act("flop", "villain", "allin"), act("flop", "hero", "allin"), act("flop", "villain", "bet", 3)], "after an all-in"],
    ];
    for (const [actions, why] of cases) {
      const { line, assumptions } = lineOf(actions);
      expect(line).toBeNull();
      expect(assumptions.at(-1)).toContain(why);
      expect(assumptions.at(-1)).toContain("strategy starts at the beginning of the flop");
    }
  });
});

const SHOVE: StreetLine = { street: "flop", steps: [{ actor: "villain", action: "allin", amountBb: 97.5 }] };
const RAISED: StreetLine = {
  street: "turn",
  steps: [
    { actor: "villain", action: "check", amountBb: null },
    { actor: "hero", action: "bet", amountBb: 4 },
    { actor: "villain", action: "raise", amountBb: 13 },
  ],
};

describe("street line mapping and wording", () => {
  it("maps to solver street_actions (chips; all-in amount left to the solver)", () => {
    expect(toSolverStreetActions(RAISED, "ip")).toEqual([
      { street: "turn", player: "oop", action: "check", amount_chips: null },
      { street: "turn", player: "ip", action: "bet", amount_chips: 400 },
      { street: "turn", player: "oop", action: "raise", amount_chips: 1300 },
    ]);
    expect(toSolverStreetActions(SHOVE, "ip")).toEqual([{ street: "flop", player: "oop", action: "allin", amount_chips: null }]);
  });

  it("describes the decision and the line", () => {
    expect(decisionText(SHOVE, "BB")).toBe("facing BB's 97.5bb all-in");
    expect(decisionText(RAISED, "BB")).toBe("facing BB's raise to 13bb");
    expect(decisionText({ street: "flop", steps: [RAISED.steps[0]] }, "BB")).toBe("after BB checks");
    expect(describeStreetLine(RAISED, "BB")).toBe("BB checked, you bet 4bb, BB raised to 13bb");
  });

  const RESULT: SolverStreetLine = {
    matched: true,
    reason: null,
    sizes: [
      { street: "turn", player: "ip", action: "bet", requested: 400, used: 400, size: "33.3%", added: true },
      { street: "turn", player: "oop", action: "raise", requested: 1300, used: 1290, size: "3.25x", added: true },
    ],
    villain_locked: false,
    villain_rare: false,
    villain_range: null,
  };

  it("assumptions: matched, added sizes, rounding, rare villain, fallback", () => {
    const out = streetAssumptions(RESULT, RAISED, "ip", false);
    expect(out[0]).toBe("Strategy shown at your decision after the turn action (villain checked, you bet 4bb, villain raised to 12.9bb)");
    expect(out[1]).toBe("Added to the solver's turn sizes: your 4bb bet and villain's raise to 12.9bb (from your description)");
    expect(out[2]).toBe("Villain's 13bb turn raise was solved as 12.9bb (the closest size the tree allows)");
    expect(streetAssumptions({ ...RESULT, villain_rare: true }, RAISED, "ip", false).at(-1)).toMatch(/almost never plays this line/);
    expect(streetAssumptions({ ...RESULT, villain_rare: true }, RAISED, "ip", true).at(-1)).not.toMatch(/almost never/);
    expect(streetAssumptions({ ...RESULT, matched: false, reason: "the action couldn't be matched" }, RAISED, "ip", false)).toEqual([
      "Couldn't play the turn action in the solver's tree (the action couldn't be matched): strategy starts at the beginning of the turn",
    ]);
    expect(streetAssumptions(undefined, RAISED, "ip", false)).toEqual([]);
  });
});

describe("known villain hand", () => {
  it("reads exact cards and classes, counting live combos", () => {
    const dead = ["Td", "9d", "6h", "Ah", "Kh"];
    expect(readVillainHand("7c2d", dead)).toEqual({ label: "7c2d", range: "7c2d", combos: 1 });
    expect(readVillainHand("2d7c", dead)?.label).toBe("7c2d");
    expect(readVillainHand("72o", dead)).toEqual({ label: "72o", range: "72o", combos: 12 });
    expect(readVillainHand("27 off", dead)?.label).toBe("72o");
    expect(readVillainHand("72s", dead)?.combos).toBe(4);
    expect(readVillainHand("72", dead)).toEqual({ label: "72", range: "72s,72o", combos: 16 });
    expect(readVillainHand("AKo", dead)?.combos).toBe(6);
    expect(readVillainHand("TT", dead)?.combos).toBe(3);
    expect(readVillainHand("Td2c", dead)?.combos).toBe(0);
    expect(readVillainHand("seven deuce", dead)).toBeNull();
  });

  const SPOT = extraction({
    num_players: 2,
    street: "flop",
    board: "Td9d6h",
    hero_position: "BTN",
    villain_position: "BB",
    hero_hand: "AhKh",
    pot_type: "srp",
    starting_stack_bb: 100,
    villain_hand: "72o",
    actions: [act("flop", "villain", "allin")],
  });

  it("sets villain's range, sends villain_hand and the shove, and says so", () => {
    const r = prepareSolve(SPOT);
    if (!r.ok) throw new Error(r.error.reason);
    expect(r.spot.oopRange).toBe("72o");
    expect(r.request.villain_hand).toBe("72o");
    expect(r.request.street_actions).toEqual([{ street: "flop", player: "oop", action: "allin", amount_chips: null }]);
    expect(r.request.line).toBeUndefined();
    expect(r.assumptions).toContain(villainKnownAssumption("72o"));
    expect(villainKnownAssumption("72o")).toBe("Villain's hand known: 72o — strategy is exact against that hand.");
  });

  it("skips narrowing on a turn spot and rejects a hand that overlaps", () => {
    const turn = prepareSolve({
      ...SPOT,
      street: "turn",
      board: "Td9d6hQc",
      amount_unit: "bb",
      actions: [act("flop", "villain", "check"), act("flop", "hero", "bet", 3), act("flop", "villain", "call"), act("turn", "villain", "bet", 8)],
    });
    if (!turn.ok) throw new Error(turn.error.reason);
    expect(turn.request.line).toBeUndefined();
    expect(turn.assumptions.some((a) => a.startsWith("Ranges narrowed") || a.startsWith("No earlier action"))).toBe(false);
    expect(validateExtraction({ ...SPOT, villain_hand: "Td2c" })?.reason).toBe("INVALID_BOARD");
    expect(validateExtraction({ ...SPOT, villain_hand: "Ah7c" })?.message).toContain("overlaps the board or your hand");
    const odd = prepareSolve({ ...SPOT, villain_hand: "a bluff" });
    expect(odd.ok && odd.assumptions.at(-1)).toMatch(/^Ignored villain hand "a bluff"/);
  });

  it("the mock LLM reads the verification prompt", () => {
    const x = mockExtraction(
      "BTN vs BB single raised pot, 100bb deep, flop Td9d6h, I'm on the button with AhKh, BB accidentally reveals his cards (72 off), goes all in, now its me.",
    );
    expect(x.villain_hand).toBe("72o");
    expect(x.actions).toEqual([act("flop", "villain", "allin")]);
  });
});

describe("presenting hero's decision", () => {
  const solver: SolverOkResponse = {
    status: "ok",
    exploitability_pct: 0.1,
    iterations: 50,
    solve_ms: 4000,
    memory_mb: 30,
    compressed: false,
    players: { oop: { equity: 0.35, ev: 1000 }, ip: { equity: 0.65, ev: 6000 } },
    nodes: [
      {
        line: ["AllIn"],
        player: "ip",
        pot: 10300,
        to_call: 9750,
        actions: [
          { action: "Fold", amount: 0, frequency: 0, top_hands: [], top_classes: [] },
          { action: "Call", amount: 0, frequency: 1, top_hands: ["AKs"], top_classes: [{ hand: "AKs", frequency: 1 }] },
        ],
      },
    ],
    hero_hand: {
      hand: "AhKh",
      node: 0,
      equity: 0.647,
      ev: 3222,
      actions: [
        { action: "Fold", amount: 0, frequency: 0, ev: 0 },
        { action: "Call", amount: 0, frequency: 1, ev: 3222 },
      ],
    },
    street_line: {
      matched: true,
      reason: null,
      sizes: [{ street: "flop", player: "oop", action: "allin", requested: 9750, used: 9750, size: "a", added: true }],
      villain_locked: true,
      villain_rare: false,
      villain_range: { combos_before: 12, combos_after: 12, classes: [{ hand: "72o", combos: 12, weight: 1 }] },
    },
  };

  it("titles the card by the decision, shows EVs and marks the best action", () => {
    const r = prepareSolve({
      ...extraction({
        num_players: 2,
        board: "Td9d6h",
        hero_position: "BTN",
        villain_position: "BB",
        hero_hand: "AhKh",
        villain_hand: "72o",
        actions: [act("flop", "villain", "allin")],
      }),
    });
    if (!r.ok) throw new Error(r.error.reason);
    const p = presentResult(solver, r.spot, r.assumptions, null, r.request.starting_pot, r);
    expect(p.heroHand?.decision).toBe("facing BB's 97.5bb all-in");
    expect(p.heroHand?.streetAction).toBe("BB went all-in 97.5bb");
    expect(p.heroHand?.actions.map((a) => [a.label, a.evBb, a.best])).toEqual([
      ["Fold", 0, false],
      ["Call 97.5bb", 32.22, true],
    ]);
    expect(p.nodes[0].title).toBe("BTN facing BB's 97.5bb all-in");
    expect(p.streetLine).toEqual({
      matched: true,
      villainRange: { position: "BB", combosBefore: 12, combosAfter: 12, classes: [{ hand: "72o", combos: 12, weight: 1 }] },
    });
    expect(p.villainHand).toBe("72o");
    expect(p.assumptions).toContain("Strategy shown at your decision after the flop action (villain went all-in 97.5bb)");
  });

  it("start-of-street results keep their wording and get EVs", () => {
    const r = prepareSolve(extraction({ board: "Td9d6h", hero_hand: "AhKh" }));
    if (!r.ok) throw new Error(r.error.reason);
    const plain: SolverOkResponse = {
      ...solver,
      street_line: undefined,
      nodes: [
        { line: [], player: "oop", actions: [{ action: "Check", amount: 0, frequency: 1, top_hands: [], top_classes: [] }] },
        { line: ["Check"], player: "ip", actions: [{ action: "Bet", amount: 275, frequency: 1, top_hands: [], top_classes: [] }] },
      ],
      hero_hand: {
        hand: "AhKh",
        node: 1,
        equity: 0.6,
        ev: 400,
        actions: [
          { action: "Check", amount: 0, frequency: 0.3, ev: 380 },
          { action: "Bet", amount: 275, frequency: 0.7, ev: 409 },
        ],
      },
    };
    const p = presentResult(plain, r.spot, r.assumptions, null, r.request.starting_pot);
    expect(p.heroHand?.decision).toBe("after BB checks");
    expect(p.heroHand?.streetAction).toBeNull();
    expect(p.heroHand?.actions.map((a) => a.best)).toEqual([false, true]);
    // 0.29bb in the 5.5bb pot at the node is 5.3% of pot.
    expect(p.heroHand?.verdict?.text).toBe("SLIGHT EDGE: BET 2.75bb (+0.29bb OVER CHECK)");
    expect(p.nodes[1].actions[0]).toMatchObject({ label: "Bet 2.75bb", potPct: 50, evBb: null });
    expect(p.streetLine).toBeNull();
  });

  it("markBest needs two EVs; ties go to the more frequent action", () => {
    const a = (ev: number | undefined, frequency: number) => presentAction({ action: "Check", amount: 0, frequency, ev }, 550);
    expect(markBest([a(1, 1)]).map((x) => x.best)).toEqual([false]);
    expect(markBest([a(100, 0.2), a(100.004, 0.8)]).map((x) => x.best)).toEqual([false, true]);
    // Check 3 of the plan: call 99% at +11.91bb vs raise 1% at +11.96bb -> call.
    expect(markBest([a(1191, 0.99), a(1196, 0.01)]).map((x) => x.best)).toEqual([true, false]);
    expect(markBest([a(400, 0.5), a(450, 0.5)]).map((x) => x.best)).toEqual([false, true]);
    expect(markBest([a(undefined, 1), a(undefined, 0)]).map((x) => x.best)).toEqual([false, false]);
  });
});

describe("pot_pct on earlier streets", () => {
  it("a half-pot flop bet sizes the turn pot", () => {
    const r = prepareSolve(
      extraction({
        board: "Ks7d2c5h",
        hero_position: "BTN",
        villain_position: "BB",
        actions: [act("flop", "villain", "check"), act("flop", "hero", "bet", null, 50), act("flop", "villain", "call"), act("turn", "villain", "bet", null, 75)],
      }),
    );
    if (!r.ok) throw new Error(r.error.reason);
    expect(r.spot.potBb).toBe(11);
    expect(r.request.street_actions).toEqual([{ street: "turn", player: "oop", action: "bet", amount_chips: 825 }]);
  });
});

describe("node titles and the solved tree after street action", () => {
  const node = (player: "oop" | "ip", actions: [SolverOkResponse["nodes"][0]["actions"][0]["action"], number][]) => ({
    line: [],
    player,
    actions: actions.map(([action, amount]) => ({ action, amount, frequency: 1 / actions.length, top_hands: [], top_classes: [] })),
  });
  const base: Omit<SolverOkResponse, "nodes" | "street_line"> = {
    status: "ok",
    exploitability_pct: 0.4,
    iterations: 70,
    solve_ms: 14000,
    memory_mb: 800,
    compressed: false,
    players: { oop: { equity: 0.56, ev: 986 }, ip: { equity: 0.44, ev: 294 } },
    hero_hand: null,
  };
  const prep = (actions: Action[], hero: "BTN" | "BB" = "BTN") => {
    const r = prepareSolve(
      extraction({ num_players: 2, board: "Jh8h3c", hero_position: hero, villain_position: hero === "BTN" ? "BB" : "BTN", actions }),
    );
    if (!r.ok) throw new Error(r.error.reason);
    return r;
  };
  const size = (player: "oop" | "ip", action: "bet" | "raise", chips: number, added = true) => ({
    street: "flop",
    player,
    action,
    requested: chips,
    used: chips,
    size: "x",
    added,
  });
  const line = (sizes: ReturnType<typeof size>[]): SolverStreetLine => ({
    matched: true,
    reason: null,
    sizes,
    villain_locked: false,
    villain_rare: false,
    villain_range: null,
  });

  it("check-raise on an auto-simplified tree: titles, coherent tree text, added sizes", () => {
    const r = prep([act("flop", "villain", "check"), act("flop", "hero", "bet", 1.8), act("flop", "villain", "raise", 5.5)]);
    const solver: SolverOkResponse = {
      ...base,
      nodes: [
        node("oop", [["Fold", 0], ["Call", 0], ["Raise", 550]]),
        node("ip", [["Fold", 0], ["Call", 0], ["Raise", 1650], ["AllIn", 9750]]),
      ],
      street_line: line([size("ip", "bet", 180), size("oop", "raise", 550)]),
      tree: {
        index: 2,
        given: 2,
        auto: "no_raises",
        bet_sizes: {
          ...r.spot.betSizes,
          flop: { bet: "33%", raise: "", oop: { bet: "", raise: "" } },
        },
        estimated_secs: 20,
        raw_mb: 600,
        over_budget: false,
      },
    };
    const p = presentResult(solver, r.spot, r.assumptions, null, r.request.starting_pot, r);
    expect(p.nodes.map((n) => n.title)).toEqual([
      "BB facing your 1.8bb bet (after checking)",
      "BTN facing BB's raise to 5.5bb (after betting 1.8bb)",
    ]);
    const tree = p.assumptions.filter((a) => a.startsWith("Flop tree:"));
    expect(tree).toEqual([
      "Flop tree: BTN (preflop raiser) bets 33%, BB doesn't lead, no other raises; added: BTN's 1.8bb bet and BB's raise to 5.5bb (from your description), BTN's raise to 16.5bb (at your decision); turn and river: 75% bets, no raises or leads into the last bettor (simplified to keep the solve fast)",
    ]);
    // Named once, in the tree text.
    expect(p.assumptions.some((a) => a.startsWith("Added to the solver's"))).toBe(false);
    expect(describeStreetSizes(p.spot.betSizes.flop, "BB", "BTN", p.spot.addedSizes)).toBe(
      "BTN 33%; NO RAISE · BB NONE; NO RAISE · ADDED: BTN BET 1.8bb, BB RAISE TO 5.5bb, BTN RAISE TO 16.5bb (YOUR DECISION)",
    );
  });

  it("an OOP lead into the preflop raiser: listed as a lead, never 'doesn't lead'", () => {
    const r = prep([act("flop", "villain", "bet", 4)]);
    const solver: SolverOkResponse = {
      ...base,
      nodes: [node("ip", [["Fold", 0], ["Call", 0], ["Raise", 1200], ["AllIn", 9750]])],
      street_line: line([size("oop", "bet", 400)]),
    };
    const p = presentResult(solver, r.spot, r.assumptions, null, r.request.starting_pot, r);
    expect(p.nodes[0].title).toBe("BTN facing BB's 4bb bet");
    const tree = p.assumptions.find((a) => a.startsWith("Flop tree:"))!;
    expect(tree).toContain("BB can check-raise 3x; added: BB's 4bb lead (from your description), BTN's raise to 12bb (at your decision);");
    expect(tree).not.toContain("doesn't lead");
    // The tree gives BTN no raise facing a lead: the solver's raise at hero's decision is added.
    expect(p.spot.addedSizes.map((a) => [a.player, a.kind, a.amountBb, a.described])).toEqual([
      ["oop", "bet", 4, true],
      ["ip", "raise", 12, false],
    ]);
    expect(describeStreetSizes(p.spot.betSizes.flop, "BB", "BTN", p.spot.addedSizes)).toBe(
      "BTN 33%, 75%; NO RAISE · BB NONE; RAISE 3x · ADDED: BB LEAD 4bb, BTN RAISE TO 12bb (YOUR DECISION)",
    );
  });

  it("hero OOP facing a bet after checking; a default size adds nothing", () => {
    const r = prep([act("flop", "hero", "check"), act("flop", "villain", "bet", null, 33)], "BB");
    const solver: SolverOkResponse = {
      ...base,
      nodes: [node("ip", [["Check", 0], ["Bet", 182]]), node("oop", [["Fold", 0], ["Call", 0], ["Raise", 545]])],
      street_line: line([size("ip", "bet", 182, false)]),
    };
    const p = presentResult(solver, r.spot, r.assumptions, null, r.request.starting_pot, r);
    expect(p.nodes.map((n) => n.title)).toEqual(["BTN after you check", "BB facing BTN's 1.82bb bet (after checking)"]);
    expect(p.heroHand).toBeNull();
    // BB can check-raise 3x in the default tree: nothing added.
    expect(p.spot.addedSizes).toEqual([]);
    expect(p.assumptions.find((a) => a.startsWith("Flop tree:"))).toContain("BB can check-raise 3x and doesn't lead;");
  });
});
