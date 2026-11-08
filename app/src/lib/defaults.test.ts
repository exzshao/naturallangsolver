import { describe, expect, it } from "vitest";
import {
  applyDefaults,
  DEFAULTS,
  flopTreeAssumption,
  flopTrees,
  preflopAggressor,
  treeChoiceAssumptions,
} from "./defaults";
import { handWeightInRange } from "./poker";
import { extraction } from "./test-helpers";

const run = (o: Parameters<typeof extraction>[0] = {}) => applyDefaults(extraction(o));

describe("§5 positions", () => {
  it("both missing -> BTN (IP) vs BB (OOP), hero on the BTN", () => {
    const { spot, assumptions } = run();
    expect(spot.ipPosition).toBe("BTN");
    expect(spot.oopPosition).toBe("BB");
    expect(spot.heroPosition).toBe("BTN");
    expect(spot.heroPlayer).toBe("ip");
    expect(assumptions.some((a) => a.includes("BTN (IP) vs BB (OOP)"))).toBe(true);
  });

  it("no assumption when both positions are given", () => {
    const { spot, assumptions } = run({ hero_position: "BB", villain_position: "BTN" });
    expect(spot.heroPlayer).toBe("oop");
    expect(assumptions.some((a) => /position|hero is|villain is|with hero on/.test(a))).toBe(false);
  });
});

describe("§5 one position missing (from pot type)", () => {
  it.each([
    // srp: BB defends against the opener
    ["srp", "BTN", "BB"],
    ["srp", "CO", "BB"],
    ["srp", "SB", "BB"],
    ["srp", "BB", "BTN"],
    // 3bet: the opener calls the (blind) 3-bettor
    ["3bet", "BB", "BTN"],
    ["3bet", "SB", "BTN"],
    ["3bet", "BTN", "BB"],
    ["4bet", "BB", "BTN"],
    ["limped", "BB", "SB"],
    ["limped", "SB", "BB"],
  ] as const)("%s, hero %s -> villain %s", (potType, hero, villain) => {
    const { spot, assumptions } = run({ pot_type: potType, hero_position: hero });
    expect(spot.villainPosition).toBe(villain);
    expect(assumptions).toContain(`Assumed villain is in the ${villain}`);
  });

  it("derives hero from villain position", () => {
    const { spot, assumptions } = run({ pot_type: "srp", villain_position: "BB" });
    expect(spot.heroPosition).toBe("BTN");
    expect(spot.heroPlayer).toBe("ip");
    expect(assumptions).toContain("Assumed hero is in the BTN");
  });

  it("ignores a villain position equal to hero's", () => {
    const { spot, assumptions } = run({ hero_position: "BTN", villain_position: "BTN" });
    expect(spot.villainPosition).toBe("BB");
    expect(assumptions.some((a) => a.startsWith("Ignored villain position"))).toBe(true);
  });
});

describe("§5 pot_type", () => {
  it("missing -> srp with an assumption", () => {
    const { spot, assumptions } = run();
    expect(spot.potType).toBe("srp");
    expect(assumptions).toContain("Assumed a single raised pot");
  });

  it("given -> no pot-type assumption", () => {
    const { spot, assumptions } = run({ pot_type: "3bet" });
    expect(spot.potType).toBe("3bet");
    expect(assumptions.some((a) => a.startsWith("Assumed a ") && a.endsWith(" pot"))).toBe(false);
  });
});

describe("§5 starting stack", () => {
  it("missing -> 100bb", () => {
    const { spot, assumptions } = run();
    expect(spot.effectiveStackBb).toBe(97.5);
    expect(assumptions).toContain("Assumed 100bb effective stacks (starting stack)");
  });

  it("stated starting stack is used", () => {
    const { spot, assumptions } = run({ starting_stack_bb: 200 });
    expect(spot.effectiveStackBb).toBe(197.5);
    expect(assumptions.some((a) => a.includes("(starting stack)"))).toBe(false);
  });

  it("stated pot without a stack -> starting stack minus half the pot", () => {
    const { spot } = run({ pot_bb: 6 });
    expect(spot.potBb).toBe(6);
    expect(spot.effectiveStackBb).toBe(97);
  });

  it("stated effective stack wins and adds no stack assumption", () => {
    const { spot, assumptions } = run({ effective_stack_bb: 50 });
    expect(spot.effectiveStackBb).toBe(50);
    expect(assumptions.some((a) => a.includes("effective stack"))).toBe(false);
  });
});

describe("§5 pot/stack on the flop by pot type and seats", () => {
  it.each([
    // BTN vs BB: the SB's 0.5bb is dead.
    ["srp", "BTN", "BB", 5.5, 97.5, "BTN opens 2.5bb, BB calls, SB folds"],
    ["3bet", "BTN", "BB", 26.5, 87, "BTN opens 2.5bb, BB 3-bets to 13bb, BTN calls, SB folds"],
    ["4bet", "BTN", "BB", 55.5, 72.5, "BTN opens 2.5bb, BB 3-bets to 13bb, BTN 4-bets to 27.5bb, BB calls, SB folds"],
    // Neither blind in the hand: 1.5bb dead.
    ["srp", "CO", "BTN", 6.5, 97.5, "CO opens 2.5bb, BTN calls, blinds fold"],
    ["3bet", "CO", "BTN", 17.5, 92, "CO opens 2.5bb, BTN 3-bets to 8bb, CO calls, blinds fold"],
    ["4bet", "UTG", "HJ", 46.5, 77.5, "UTG opens 2.5bb, HJ 3-bets to 9bb, UTG 4-bets to 22.5bb, HJ calls, blinds fold"],
    // SB in the hand: the BB's 1bb is dead.
    ["srp", "UTG", "SB", 6, 97.5, "UTG opens 2.5bb, SB calls, BB folds"],
    ["3bet", "BTN", "SB", 24, 88.5, "BTN opens 2.5bb, SB 3-bets to 11.5bb, BTN calls, BB folds"],
    ["4bet", "HJ", "SB", 51, 75, "HJ opens 2.5bb, SB 3-bets to 12bb, HJ 4-bets to 25bb, SB calls, BB folds"],
    // SB vs BB: no dead money.
    ["srp", "SB", "BB", 7, 96.5, "SB opens 3.5bb, BB calls"],
    ["3bet", "BB", "SB", 21, 89.5, "SB opens 3.5bb, BB 3-bets to 10.5bb, SB calls"],
    ["4bet", "SB", "BB", 44, 78, "SB opens 3.5bb, BB 3-bets to 10.5bb, SB 4-bets to 22bb, BB calls"],
    ["limped", "SB", "BB", 2, 99, "SB limps, BB checks"],
    ["limped", "BTN", "BB", 2.5, 99, "BTN limps, BB checks, SB folds"],
  ] as const)("%s %s vs %s -> pot %s, stack %s", (potType, hero, villain, pot, stack, line) => {
    const { spot, assumptions } = run({ pot_type: potType, hero_position: hero, villain_position: villain });
    expect(spot.potBb).toBe(pot);
    expect(spot.effectiveStackBb).toBe(stack);
    expect(assumptions).toContain(`Assumed a ${pot}bb pot: ${line}`);
    expect(assumptions).toContain(`Assumed ${stack}bb effective stack at the start of the flop`);
    expect(assumptions).not.toContain("Assumed it checked through previous streets");
  });

  it("no positions -> BTN vs BB sizes", () => {
    const { spot, assumptions } = run({ pot_type: "3bet" });
    expect(spot.potBb).toBe(26.5);
    expect(spot.effectiveStackBb).toBe(87);
    expect(assumptions).toContain("Assumed a 26.5bb pot: BTN opens 2.5bb, BB 3-bets to 13bb, BTN calls, SB folds");
  });

  it("stated starting stack minus the seat pair's investment", () => {
    const { spot } = run({ pot_type: "3bet", hero_position: "CO", villain_position: "BTN", starting_stack_bb: 200 });
    expect(spot.effectiveStackBb).toBe(192);
  });

  it("a stated pot wins over the size table", () => {
    const { spot, assumptions } = run({ pot_type: "3bet", hero_position: "CO", villain_position: "BTN", pot_bb: 20 });
    expect(spot.potBb).toBe(20);
    expect(spot.effectiveStackBb).toBe(90);
    expect(assumptions.some((a) => a.startsWith("Assumed a 17.5bb pot"))).toBe(false);
  });

  it("history-derived pots win over the size table", () => {
    const { spot, assumptions } = run({
      pot_type: "srp",
      hero_position: "CO",
      villain_position: "BTN",
      amount_unit: "bb",
      actions: [
        { street: "preflop", actor: "hero", action: "open", amount: 3 },
        { street: "preflop", actor: "villain", action: "call", amount: null },
      ],
      board: "Td9d6hQc",
    });
    expect(spot.potBb).toBe(7.5);
    expect(assumptions.some((a) => a.startsWith("Assumed a 6.5bb pot"))).toBe(false);
  });

  it("falls back to the generic pot for a seat pair missing from the size table", () => {
    const saved = DEFAULTS.preflopSizes;
    DEFAULTS.preflopSizes = {};
    try {
      const { spot, assumptions } = run({ pot_type: "3bet", hero_position: "CO", villain_position: "BTN" });
      expect(spot.potBb).toBe(20);
      expect(spot.effectiveStackBb).toBe(90);
      expect(assumptions).toContain("Assumed a 20bb pot (standard 3-bet pot at the flop)");
    } finally {
      DEFAULTS.preflopSizes = saved;
    }
  });
});

describe("§5 pot/stack on turn/river with no info", () => {
  it.each([
    ["turn", "Td9d6hQc"],
    ["river", "Td9d6hQc2s"],
  ] as const)("%s uses flop values and assumes checked through", (street, board) => {
    const { spot, assumptions } = run({ board, pot_type: "3bet" });
    expect(spot.street).toBe(street);
    expect(spot.potBb).toBe(26.5);
    expect(spot.effectiveStackBb).toBe(87);
    expect(assumptions).toContain("Assumed it checked through previous streets");
  });

  it("no checked-through assumption when the pot is stated", () => {
    const { assumptions } = run({ board: "Td9d6hQc", pot_bb: 12 });
    expect(assumptions).not.toContain("Assumed it checked through previous streets");
  });
});

describe("§5 ranges", () => {
  it.each([
    ["srp", "BTN", "BB", "srp:BTNvBB", "BTN open vs BB call"],
    ["srp", "CO", "BB", "srp:COvBB", "CO open vs BB call"],
    ["srp", "SB", "BB", "srp:BBvSB", "SB open vs BB call"],
    ["srp", "BTN", "CO", "srp:BTNvCO", "CO open vs BTN call"],
    ["3bet", "BTN", "SB", "3bet:BTNvSB", "BTN open, SB 3-bet, BTN call"],
    ["3bet", "BB", "BTN", "3bet:BTNvBB", "BTN open, BB 3-bet, BTN call"],
    ["4bet", "UTG", "HJ", "4bet:HJvUTG", "UTG open, HJ 3-bet, UTG 4-bet, HJ call"],
    ["limped", "SB", "BB", "limped:BBvSB", "SB limp vs BB check"],
  ] as const)("%s %s vs %s uses table entry %s", (potType, hero, villain, key, line) => {
    const { spot, assumptions } = run({ pot_type: potType, hero_position: hero, villain_position: villain });
    const entry = DEFAULTS.ranges[key]!;
    expect(spot.ipRange).toBe(entry.ip);
    expect(spot.oopRange).toBe(entry.oop);
    expect(assumptions).toContain(`Assumed standard 100bb ranges: ${line}`);
  });

  it("limped pots outside SB vs BB fall back to the generic limped ranges", () => {
    const { spot, assumptions } = run({ pot_type: "limped", hero_position: "BTN", villain_position: "CO" });
    expect(spot.oopRange).toBe(DEFAULTS.fallbackRanges.limped.oop);
    expect(spot.ipRange).toBe(DEFAULTS.fallbackRanges.limped.ip);
    expect(assumptions).toContain("Assumed generic limped ranges (no standard 100bb ranges for BTN vs CO)");
  });

  it("keeps user ranges and only defaults the missing side", () => {
    const { spot, assumptions } = run({ oop_range: "QQ+,AK" });
    expect(spot.oopRange).toBe("QQ+,AK");
    expect(spot.ipRange).toBe(DEFAULTS.ranges["srp:BTNvBB"]!.ip);
    expect(assumptions).toContain("Assumed IP (BTN) range from standard 100bb ranges: BTN open vs BB call");
  });

  it("defaults the OOP side when only the IP range is given", () => {
    const { spot, assumptions } = run({ ip_range: "AA" });
    expect(spot.ipRange).toBe("AA");
    expect(spot.oopRange).toBe(DEFAULTS.ranges["srp:BTNvBB"]!.oop);
    expect(assumptions).toContain("Assumed OOP (BB) range from standard 100bb ranges: BTN open vs BB call");
  });

  it("no range assumption when both are given", () => {
    const { assumptions } = run({ oop_range: "QQ+", ip_range: "AA" });
    expect(assumptions.some((a) => a.includes("range"))).toBe(false);
  });

  it("all table and fallback ranges parse", () => {
    const all = [...Object.values(DEFAULTS.ranges), ...Object.values(DEFAULTS.fallbackRanges)];
    for (const pair of all) {
      expect(handWeightInRange(pair!.ip, "2c2d")).not.toBeNull();
      expect(handWeightInRange(pair!.oop, "2c2d")).not.toBeNull();
    }
  });
});

describe("§5 bet sizes", () => {
  it("turn/river spots: 33%, 75% / 3x on all streets, all-in added on the river", () => {
    for (const board of ["Td9d6hQc", "Td9d6hQc2s"]) {
      const { spot, assumptions } = run({ board });
      expect(spot.betSizes).toEqual({
        flop: { bet: "33%, 75%", raise: "3x" },
        turn: { bet: "33%, 75%", raise: "3x" },
        river: { bet: "33%, 75%, a", raise: "3x" },
      });
      const streets = board.length === 8 ? "turn and river" : "river";
      expect(assumptions.some((a) => a.startsWith(`Bet sizes the solver considers on the ${streets}: 33%, 75%`))).toBe(true);
      expect(assumptions.some((a) => a.includes("raises 3x (you didn't specify)"))).toBe(true);
      expect(assumptions.some((a) => a.startsWith("Bet sizes") && a.includes("flop"))).toBe(false);
      expect(assumptions.some((a) => a.startsWith("Flop tree"))).toBe(false);
      expect(spot.betSizeFallbacks).toEqual([]);
    }
  });

  it("flop spots: tree built around the preflop raiser, with a simpler fallback", () => {
    const { spot, assumptions } = run();
    const later = { bet: "75%", raise: "", donk: "" };
    expect(spot.preflopAggressor).toBe("ip");
    expect(spot.betSizes).toEqual({
      flop: { bet: "33%, 75%", raise: "", oop: { bet: "", raise: "3x" } },
      turn: later,
      river: later,
    });
    expect(spot.betSizeFallbacks).toEqual([
      { flop: { bet: "33%", raise: "", oop: { bet: "", raise: "3x" } }, turn: later, river: later },
    ]);
    expect(assumptions).toContain(
      "Flop tree: BTN (preflop raiser) bets 33% or 75%, BB can check-raise 3x and doesn't lead; turn and river: 75% bets, no raises or leads into the last bettor",
    );
  });

  it("flop spots: OOP raiser c-bets, IP caller can raise or stab; limped pots have no raiser", () => {
    const bb3bet = run({ pot_type: "3bet", hero_position: "BTN", villain_position: "BB" });
    expect(bb3bet.spot.preflopAggressor).toBe("oop");
    expect(bb3bet.spot.betSizes.flop).toEqual({ bet: "33%, 75%", raise: "", ip: { bet: "33%", raise: "3x" } });
    expect(bb3bet.assumptions).toContain(
      "Flop tree: BB (preflop raiser) bets 33% or 75%, BTN can raise 3x or bet 33% when checked to; turn and river: 75% bets, no raises or leads into the last bettor",
    );
    const limped = run({ pot_type: "limped", hero_position: "BB", villain_position: "SB" });
    expect(limped.spot.preflopAggressor).toBeNull();
    expect(limped.spot.betSizes.flop).toEqual({ bet: "33%, 75%", raise: "", oop: { raise: "3x" } });
    expect(limped.assumptions.some((a) => a.startsWith("Flop tree: both players bet 33% or 75%, SB can check-raise 3x"))).toBe(true);
  });

  it("preflop raiser by pot type and seats", () => {
    expect(preflopAggressor("srp", "BTN", "BB")).toBe("ip");
    expect(preflopAggressor("srp", "BB", "SB")).toBe("oop"); // SB opens, BB calls
    expect(preflopAggressor("3bet", "CO", "BTN")).toBe("ip"); // BTN 3-bets the CO
    expect(preflopAggressor("3bet", "BB", "BTN")).toBe("oop");
    expect(preflopAggressor("4bet", "BTN", "CO")).toBe("oop"); // CO opens and 4-bets
    expect(preflopAggressor("limped", "SB", "BB")).toBeNull();
  });

  it("tree choice: a fallback or auto-simplified tree replaces the flop tree text", () => {
    const { spot, assumptions } = run();
    const seats = spot.flopTreeSeats!;
    const rich = flopTreeAssumption(seats, "33%, 75%");
    const choice = (index: number, auto?: "no_raises" | "one_size") => ({
      index,
      given: 2,
      auto,
      bet_sizes: auto ? { ...flopTrees("ip")[1], flop: { bet: "33%", raise: "", oop: { bet: "", raise: "" } } } : spot.betSizes,
      estimated_secs: 25,
      raw_mb: 640,
      over_budget: false,
    });
    expect(treeChoiceAssumptions(spot, assumptions, undefined)).toBe(assumptions);
    expect(treeChoiceAssumptions(spot, assumptions, choice(0))).toBe(assumptions);
    const fallback = treeChoiceAssumptions(spot, assumptions, choice(1));
    expect(fallback).not.toContain(rich);
    expect(fallback).toContain(
      "Flop tree: BTN (preflop raiser) bets 33%, BB can check-raise 3x and doesn't lead; turn and river: 75% bets, no raises or leads into the last bettor",
    );
    expect(fallback).toHaveLength(assumptions.length);
    const auto = treeChoiceAssumptions(spot, assumptions, choice(2, "no_raises"));
    expect(auto).toContain(
      "Flop tree: BTN (preflop raiser) bets 33%, BB doesn't lead, no raises; turn and river: 75% bets, no raises or leads into the last bettor (simplified to keep the solve fast)",
    );
    // Turn spot (no default flop tree): a note is appended.
    const turn = run({ board: "Td9d6hQc" });
    const t = treeChoiceAssumptions(turn.spot, turn.assumptions, { ...choice(1, "one_size"), given: 1 });
    expect(t.at(-1)).toBe("Tree simplified to keep the solve fast: raises dropped and one bet size per street");
  });

  it("tree texts name sizes added from the described action instead of contradicting them", () => {
    const { spot, assumptions } = run();
    const seats = spot.flopTreeSeats!;
    const lead = { street: "flop", player: "oop", kind: "bet", allin: false, amountBb: 4, described: true } as const;
    const bet = { ...lead, player: "ip", amountBb: 1.8 } as const;
    const raise = { ...lead, kind: "raise", amountBb: 5.5 } as const;
    const heroRaise = { ...lead, player: "ip", kind: "raise", amountBb: 16.5, described: false } as const;
    // BB's lead: "doesn't lead" goes; the lead is listed.
    const withLead = treeChoiceAssumptions(spot, assumptions, undefined, [lead]);
    expect(withLead).not.toContain(flopTreeAssumption(seats, "33%, 75%"));
    expect(withLead).toContain(
      "Flop tree: BTN (preflop raiser) bets 33% or 75%, BB can check-raise 3x; added: BB's 4bb lead (from your description); turn and river: 75% bets, no raises or leads into the last bettor",
    );
    // Simplified tree without raises plus a check-raise: "no other raises".
    const auto = {
      index: 2,
      given: 2,
      auto: "no_raises" as const,
      bet_sizes: { ...flopTrees("ip")[1], flop: { bet: "33%", raise: "", oop: { bet: "", raise: "" } } },
      estimated_secs: 25,
      raw_mb: 640,
      over_budget: false,
    };
    expect(treeChoiceAssumptions(spot, assumptions, auto, [bet, raise, heroRaise])).toContain(
      "Flop tree: BTN (preflop raiser) bets 33%, BB doesn't lead, no other raises; added: BTN's 1.8bb bet and BB's raise to 5.5bb (from your description), BTN's raise to 16.5bb (at your decision); turn and river: 75% bets, no raises or leads into the last bettor (simplified to keep the solve fast)",
    );
    // OOP preflop raiser and limped pots.
    expect(flopTreeAssumption({ ...seats, aggressor: "oop" }, "33%", false, [{ ...raise, player: "ip" }])).toBe(
      "Flop tree: BB (preflop raiser) bets 33%, BTN can bet 33% when checked to, no other raises; added: BTN's raise to 5.5bb (from your description); turn and river: 75% bets, no raises or leads into the last bettor",
    );
    expect(flopTreeAssumption({ ...seats, aggressor: null }, "33%", true, [{ ...lead, allin: true, amountBb: 97.5 }])).toBe(
      "Flop tree: both players bet 33%, BB can check-raise 3x; added: BB's 97.5bb all-in (from your description); turn and river: 75% bets, no raises or leads into the last bettor",
    );
    // User-sized flop trees and auto-simplified turn trees keep the added sizes.
    const noRaise = run({ bet_sizes: { bet: "50%", raise: null } });
    expect(treeChoiceAssumptions(noRaise.spot, noRaise.assumptions, undefined, [raise])).toContain(
      "Assumed no raises to keep the flop tree small (except the added sizes below)",
    );
    const oneSize = run({ bet_sizes: { bet: null, raise: "3x" } });
    expect(treeChoiceAssumptions(oneSize.spot, oneSize.assumptions, undefined, [lead])).toContain(
      "Assumed one bet size per street (33% flop, 75% turn and river) to keep the flop tree small (except the added sizes below)",
    );
    const turn = run({ board: "Td9d6hQc" });
    const t = treeChoiceAssumptions(turn.spot, turn.assumptions, { ...auto, index: 1, given: 1 }, [{ ...raise, street: "turn" }]);
    expect(t.at(-1)).toBe("Tree simplified to keep the solve fast: raises dropped (except the added sizes below)");
  });

  it("user sizes apply to every street", () => {
    for (const board of ["Td9d6h", "Td9d6hQc2s"]) {
      const { spot, assumptions } = run({ board, bet_sizes: { bet: "50%", raise: "2.5x" } });
      for (const s of ["flop", "turn", "river"] as const) {
        expect(spot.betSizes[s]).toEqual({ bet: "50%", raise: "2.5x" });
      }
      expect(assumptions.some((a) => /bet size|raises|flop tree/.test(a))).toBe(false);
    }
  });

  it("user bet only -> default raise (3x on turn/river, none on flop)", () => {
    const turn = run({ board: "Td9d6hQc", bet_sizes: { bet: "50%", raise: null } });
    expect(turn.spot.betSizes.turn).toEqual({ bet: "50%", raise: "3x" });
    expect(turn.assumptions).toContain("Raise size the solver considers on the turn and river: 3x (you didn't specify)");

    const flop = run({ bet_sizes: { bet: "50%", raise: null } });
    expect(flop.spot.betSizes.flop).toEqual({ bet: "50%", raise: "" });
    expect(flop.assumptions).toContain("Assumed no raises to keep the flop tree small");
  });

  it("user raise only -> default bets", () => {
    const river = run({ board: "Td9d6hQc2s", bet_sizes: { bet: null, raise: "4x" } });
    expect(river.spot.betSizes.river).toEqual({ bet: "33%, 75%, a", raise: "4x" });

    const flop = run({ bet_sizes: { bet: null, raise: "4x" } });
    expect(flop.spot.betSizes.flop).toEqual({ bet: "33%", raise: "4x" });
    expect(flop.spot.betSizeFallbacks).toEqual([]);
    expect(flop.spot.betSizes.river).toEqual({ bet: "75%", raise: "4x" });
  });
});

describe("§5 solver constants", () => {
  it("donk sizes are null (solver defaults)", () => {
    expect(DEFAULTS.donkSizes).toBeNull();
  });

  it("thresholds", () => {
    expect(DEFAULTS.thresholds).toEqual({ addAllin: 1.5, forceAllin: 0.15, merging: 0.1, rake: 0 });
  });

  it("iterations and target exploitability", () => {
    const { spot } = run();
    expect(spot.maxIterations).toBe(1000);
    expect(spot.targetExploitabilityPct).toBe(0.5);
  });
});

describe("§5 hero_hand not in hero's range", () => {
  it("adds it at weight 1 with an assumption (IP)", () => {
    const { spot, assumptions } = run({ hero_hand: "7c2d" });
    expect(spot.heroHand).toBe("7c2d");
    expect(spot.ipRange.startsWith("7c2d,")).toBe(true);
    expect(handWeightInRange(spot.ipRange, "7c2d")).toBe(1);
    expect(assumptions).toContain("Added hero's hand 7c2d to the IP range at weight 1");
  });

  it("adds it to the OOP range when hero is OOP", () => {
    const { spot } = run({ hero_position: "BB", villain_position: "BTN", hero_hand: "AsKs" });
    expect(spot.oopRange.startsWith("AsKs,")).toBe(true);
    expect(spot.ipRange).toBe(DEFAULTS.ranges["srp:BTNvBB"]!.ip);
  });

  it("overrides an explicit weight-0 entry", () => {
    const { spot } = run({ ip_range: "AKs:0,QQ+", hero_hand: "AhKh" });
    expect(handWeightInRange(spot.ipRange, "AhKh")).toBe(1);
  });

  it("leaves the range alone when the hand is already in it", () => {
    const { spot, assumptions } = run({ hero_hand: "KhAh" });
    expect(spot.heroHand).toBe("AhKh");
    expect(spot.ipRange).toBe(DEFAULTS.ranges["srp:BTNvBB"]!.ip);
    expect(assumptions.some((a) => a.startsWith("Added hero's hand"))).toBe(false);
  });

  it("drops a hand without exact suits", () => {
    const { spot, assumptions } = run({ hero_hand: "AK" });
    expect(spot.heroHand).toBeNull();
    expect(assumptions.some((a) => a.startsWith('Ignored hero hand "AK"'))).toBe(true);
  });
});

describe("§5 board normalization", () => {
  it("normalizes the board and derives the street", () => {
    const { spot } = run({ board: "td 9d 6h qc" });
    expect(spot.board).toBe("Td9d6hQc");
    expect(spot.street).toBe("turn");
  });
});
