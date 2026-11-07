import { describe, expect, it } from "vitest";
import { applyDefaults } from "./defaults";
import { bbPerUnit, historyProblem, inferHeroIp, inferPotType } from "./history";
import { prepareSolve } from "./request";
import type { Action } from "./schema";
import { extraction } from "./test-helpers";
import { validateExtraction } from "./validate";

const act = (street: Action["street"], actor: Action["actor"], action: Action["action"], amount: number | null = null): Action => ({
  street,
  actor,
  action,
  amount,
});

// The bug report: "open raise to 15, he re-raises to 60. We flop a set, he
// checks, we raise 125, he calls. Turn ... he checks." No blind size given.
const USER_ACTIONS: Action[] = [
  act("preflop", "hero", "open", 15),
  act("preflop", "villain", "3bet", 60),
  act("preflop", "hero", "call"),
  act("flop", "villain", "check"),
  act("flop", "hero", "raise", 125), // "raise" into a check = bet
  act("flop", "villain", "call"),
  act("turn", "villain", "check"),
];
const userSpot = (overrides: Parameters<typeof extraction>[0] = {}) =>
  extraction({
    num_players: 2,
    street: "turn",
    board: "Qh2c7h8h",
    hero_hand: "2h2s",
    amount_unit: "chips",
    actions: USER_ACTIONS,
    ...overrides,
  });

describe("bug report spot: chips with no blind size", () => {
  const { spot, assumptions } = applyDefaults(userSpot());

  it("infers the big blind from a 3x open", () => {
    expect(assumptions).toContain("Assumed a 5 big blind (your 15 open as a standard 3x raise)");
  });

  it("pot = 12 + 12 + 25 + 25 + 0.5 dead SB = 74.5bb", () => {
    expect(spot.potBb).toBe(74.5);
    expect(assumptions).toContain("Counted the 0.5bb small blind as dead money (BTN vs BB)");
    expect(assumptions).toContain("Computed a 74.5bb pot at the start of the turn from the betting");
  });

  it("effective stack = 100 - 37 = 63bb", () => {
    expect(spot.effectiveStackBb).toBe(63);
    expect(assumptions).toContain("Computed a 63bb effective stack at the start of the turn (100bb minus 37bb put in)");
  });

  it("3-bet pot, hero IP on the BTN, 3-bet ranges", () => {
    expect(spot.potType).toBe("3bet");
    expect(spot.heroPlayer).toBe("ip");
    expect(spot.heroPosition).toBe("BTN");
    expect(spot.villainPosition).toBe("BB");
    expect(assumptions.some((a) => a.startsWith("Assumed a 3-bet pot") || a === "Assumed a single raised pot")).toBe(false);
  });

  it("no checked-through, no standard-pot assumption", () => {
    expect(assumptions.some((a) => a.includes("checked through"))).toBe(false);
    expect(assumptions.some((a) => a.includes("bb pot (standard"))).toBe(false);
  });

  it("bet-size assumption only covers streets still to play", () => {
    expect(assumptions).toContain(
      "Bet sizes the solver considers on the turn and river: 33%, 75%, plus all-in on the river; raises 3x (you didn't specify)",
    );
    expect(assumptions.some((a) => a.includes("every street"))).toBe(false);
  });

  it("same result when the model leaves out hero's call (implied)", () => {
    const r = applyDefaults(userSpot({ actions: USER_ACTIONS.filter((a) => a.action !== "call" || a.street !== "preflop") }));
    expect(r.spot.potBb).toBe(74.5);
    expect(r.spot.effectiveStackBb).toBe(63);
    expect(r.assumptions).toContain("Assumed you called villain's 60 3-bet preflop");
  });

  it("a stated big blind wins over the 3x inference", () => {
    const r = applyDefaults(userSpot({ big_blind_size: 2.5 }));
    // 24 + 24 + 50 + 50 + 0.5
    expect(r.spot.potBb).toBe(148.5);
    expect(r.spot.effectiveStackBb).toBe(26);
    expect(r.assumptions.some((a) => a.includes("big blind ("))).toBe(false);
  });

  it("prepares a solver request in chips", () => {
    const r = prepareSolve(userSpot());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.starting_pot).toBe(7450);
      expect(r.request.effective_stack).toBe(6300);
      expect(r.request.hero).toEqual({ player: "ip", hand: "2s2h" });
    }
  });
});

describe("history in big blinds", () => {
  const actions = [
    act("preflop", "villain", "open", 2.5),
    act("preflop", "hero", "call"),
    act("flop", "hero", "check"),
    act("flop", "villain", "bet", 4),
    act("flop", "hero", "call"),
  ];

  it("srp BB defends: pot 2.5 + 2.5 + 0.5 + 8 = 13.5, stack 100 - 6.5", () => {
    const { spot, assumptions } = applyDefaults(
      extraction({ board: "Td9d6hQc", hero_position: "BB", villain_position: "BTN", amount_unit: "bb", actions }),
    );
    expect(spot.potType).toBe("srp");
    expect(spot.potBb).toBe(13.5);
    expect(spot.effectiveStackBb).toBe(93.5);
    expect(assumptions.some((a) => a.includes("big blind ("))).toBe(false);
  });

  it("positions unknown and hero acts first postflop -> hero OOP in the BB", () => {
    const { spot } = applyDefaults(extraction({ board: "Td9d6hQc", amount_unit: "bb", actions }));
    expect(spot.heroPlayer).toBe("oop");
    expect(spot.heroPosition).toBe("BB");
    expect(spot.potBb).toBe(13.5);
  });

  it("no dead money in SB vs BB; 1.5bb when neither is a blind", () => {
    const sbbb = applyDefaults(
      extraction({ board: "Td9d6hQc", hero_position: "SB", villain_position: "BB", amount_unit: "bb", actions: [act("preflop", "hero", "open", 3), act("preflop", "villain", "call")] }),
    );
    expect(sbbb.spot.potBb).toBe(6);
    const cobtn = applyDefaults(
      extraction({ board: "Td9d6h", hero_position: "CO", villain_position: "BTN", amount_unit: "bb", actions: [act("preflop", "hero", "open", 2.5), act("preflop", "villain", "call")] }),
    );
    expect(cobtn.spot.potBb).toBe(6.5);
    expect(cobtn.assumptions).toContain("Counted 1.5bb of blinds as dead money (CO vs BTN)");
  });

  it("names only the streets with no action as checked through", () => {
    const { assumptions } = applyDefaults(
      extraction({ board: "Td9d6hQc2s", amount_unit: "bb", actions: [...actions, act("river", "hero", "check")] }),
    );
    expect(assumptions).toContain("Assumed the turn checked through");
    expect(assumptions).not.toContain("Assumed it checked through previous streets");
  });

  it("preflop amounts unknown -> standard pot for the pot type, then postflop bets added", () => {
    const { spot, assumptions } = applyDefaults(
      extraction({
        board: "Td9d6hQc",
        pot_type: "3bet",
        amount_unit: "bb",
        actions: [act("flop", "villain", "check"), act("flop", "hero", "bet", 7), act("flop", "villain", "call")],
      }),
    );
    expect(spot.potBb).toBe(34);
    expect(spot.effectiveStackBb).toBe(83);
    expect(assumptions).toContain("Assumed a 20bb pot (standard 3-bet pot at the flop)");
  });
});

describe("missing history falls back to the pot-type defaults", () => {
  it("no actions -> standard pot, checked through", () => {
    const { spot, assumptions } = applyDefaults(extraction({ board: "Td9d6hQc", pot_type: "3bet" }));
    expect(spot.potBb).toBe(20);
    expect(spot.effectiveStackBb).toBe(90);
    expect(assumptions).toContain("Assumed it checked through previous streets");
  });

  it("only current-street actions -> same fallback", () => {
    const { spot, assumptions } = applyDefaults(
      extraction({ board: "Td9d6hQc", pot_type: "3bet", actions: [act("turn", "villain", "check")] }),
    );
    expect(spot.potBb).toBe(20);
    expect(spot.heroPlayer).toBe("ip");
    expect(assumptions).toContain("Assumed it checked through previous streets");
  });

  it("preflop action without amounts on a flop spot adds nothing -> plain defaults", () => {
    const { spot, assumptions } = applyDefaults(
      extraction({ actions: [act("preflop", "villain", "open"), act("preflop", "hero", "call")] }),
    );
    expect(spot.potBb).toBe(5.5);
    expect(assumptions.some((a) => a.startsWith("Computed"))).toBe(false);
  });

  it("a stated pot wins over the history (stack = start - half the pot)", () => {
    const { spot } = applyDefaults(userSpot({ pot_bb: 80 }));
    expect(spot.potBb).toBe(80);
    expect(spot.effectiveStackBb).toBe(60);
  });
});

describe("inference helpers", () => {
  it.each([
    [[act("preflop", "hero", "open", 3), act("preflop", "villain", "call")], "srp"],
    [[act("preflop", "hero", "raise", 3), act("preflop", "villain", "raise", 10)], "3bet"],
    [[act("preflop", "hero", "open", 3), act("preflop", "villain", "3bet", 10)], "3bet"],
    [[act("preflop", "hero", "open"), act("preflop", "villain", "3bet"), act("preflop", "hero", "4bet")], "4bet"],
    [[act("preflop", "hero", "limp"), act("preflop", "villain", "check")], "limped"],
    [[act("flop", "hero", "bet", 3)], null],
  ] as const)("pot type %#", (actions, expected) => {
    expect(inferPotType([...actions])).toBe(expected);
  });

  it("hero IP when villain acts first after the flop", () => {
    expect(inferHeroIp(USER_ACTIONS)).toBe(true);
    expect(inferHeroIp([act("turn", "hero", "check")])).toBe(false);
    expect(inferHeroIp([act("preflop", "hero", "open", 3)])).toBeNull();
  });

  it("bb per unit: bb, stated blind, inferred, unknown", () => {
    expect(bbPerUnit({ amount_unit: "bb", big_blind_size: null, actions: null }).factor).toBe(1);
    expect(bbPerUnit({ amount_unit: "chips", big_blind_size: 2, actions: null }).factor).toBe(0.5);
    expect(bbPerUnit({ amount_unit: "chips", big_blind_size: null, actions: USER_ACTIONS }).factor).toBeCloseTo(0.2);
    expect(bbPerUnit({ amount_unit: "chips", big_blind_size: null, actions: [act("flop", "hero", "bet", 50)] }).factor).toBeNull();
  });
});

describe("inconsistent amounts -> INVALID_STACKS", () => {
  it("a raise that isn't bigger than the bet before it", () => {
    const x = userSpot({ actions: [act("preflop", "hero", "open", 15), act("preflop", "villain", "3bet", 10)] });
    expect(historyProblem(x)).toMatch(/isn't bigger/);
    expect(validateExtraction(x)?.reason).toBe("INVALID_STACKS");
  });

  it("non-positive amounts or blind size", () => {
    expect(validateExtraction(userSpot({ big_blind_size: 0 }))?.reason).toBe("INVALID_STACKS");
    expect(validateExtraction(userSpot({ actions: [act("flop", "hero", "bet", -5)] }))?.reason).toBe("INVALID_STACKS");
  });

  it("bets bigger than the starting stack", () => {
    const r = prepareSolve(userSpot({ starting_stack_bb: 30 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe("INVALID_STACKS");
      expect(r.error.message).toMatch(/more than the stacks/);
    }
  });
});
