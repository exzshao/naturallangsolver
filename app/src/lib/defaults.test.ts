import { describe, expect, it } from "vitest";
import { applyDefaults, DEFAULTS, FLOP_TREE_ASSUMPTION } from "./defaults";
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

describe("§5 pot/stack on the flop by pot type", () => {
  it.each([
    ["srp", 5.5, 97.5],
    ["3bet", 20, 90],
    ["4bet", 45, 77.5],
    ["limped", 2, 99],
  ] as const)("%s -> pot %s, stack %s", (potType, pot, stack) => {
    const { spot, assumptions } = run({ pot_type: potType });
    expect(spot.potBb).toBe(pot);
    expect(spot.effectiveStackBb).toBe(stack);
    expect(assumptions.some((a) => a.startsWith(`Assumed a ${pot}bb pot`))).toBe(true);
    expect(assumptions).not.toContain("Assumed it checked through previous streets");
  });
});

describe("§5 pot/stack on turn/river with no info", () => {
  it.each([
    ["turn", "Td9d6hQc"],
    ["river", "Td9d6hQc2s"],
  ] as const)("%s uses flop values and assumes checked through", (street, board) => {
    const { spot, assumptions } = run({ board, pot_type: "3bet" });
    expect(spot.street).toBe(street);
    expect(spot.potBb).toBe(20);
    expect(spot.effectiveStackBb).toBe(90);
    expect(assumptions).toContain("Assumed it checked through previous streets");
  });

  it("no checked-through assumption when the pot is stated", () => {
    const { assumptions } = run({ board: "Td9d6hQc", pot_bb: 12 });
    expect(assumptions).not.toContain("Assumed it checked through previous streets");
  });
});

describe("§5 ranges", () => {
  it.each([
    ["srp", "BTN", "BB", "srp:BTNvBB"],
    ["srp", "CO", "BB", "srp:COvBB"],
    ["srp", "SB", "BB", "srp:BBvSB"],
    ["3bet", "BTN", "SB", "3bet:BTNvSB"],
    ["3bet", "BB", "BTN", "3bet:BTNvBB"],
  ] as const)("%s %s vs %s uses the seeded table entry %s", (potType, hero, villain, key) => {
    const { spot, assumptions } = run({ pot_type: potType, hero_position: hero, villain_position: villain });
    const seed = DEFAULTS.ranges[key]!;
    expect(spot.ipRange).toBe(seed.ip);
    expect(spot.oopRange).toBe(seed.oop);
    expect(assumptions.some((a) => a.startsWith(`Assumed default ${potType} ranges`))).toBe(true);
  });

  it("matches the spec's srp BTN-v-BB seeds (dash ranges written descending, as the crate requires)", () => {
    const { spot } = run();
    expect(spot.ipRange).toBe(
      "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o",
    );
    expect(spot.oopRange).toBe(
      "JJ-22,AJs-A2s,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,75s+,64s+,53s+,AJo-A2o,K9o+,Q9o+,J9o+,T9o",
    );
  });

  it.each(["srp", "3bet", "4bet", "limped"] as const)("%s falls back to generic ranges for unseeded pairs", (potType) => {
    const { spot, assumptions } = run({ pot_type: potType, hero_position: "UTG", villain_position: "HJ" });
    expect(spot.oopRange).toBe(DEFAULTS.fallbackRanges[potType].oop);
    expect(spot.ipRange).toBe(DEFAULTS.fallbackRanges[potType].ip);
    expect(assumptions.some((a) => a.startsWith(`Assumed generic ${potType} ranges`))).toBe(true);
  });

  it("keeps user ranges and only defaults the missing side", () => {
    const { spot, assumptions } = run({ oop_range: "QQ+,AK" });
    expect(spot.oopRange).toBe("QQ+,AK");
    expect(spot.ipRange).toBe(DEFAULTS.ranges["srp:BTNvBB"]!.ip);
    expect(assumptions.some((a) => a.startsWith("Assumed IP (BTN) range"))).toBe(true);
  });

  it("no range assumption when both are given", () => {
    const { assumptions } = run({ oop_range: "QQ+", ip_range: "AA" });
    expect(assumptions.some((a) => a.includes("range"))).toBe(false);
  });

  it("all seeded and fallback ranges parse", () => {
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
      expect(assumptions.some((a) => a.startsWith("Assumed bet sizes 33%, 75% and raises of 3x"))).toBe(true);
      expect(assumptions).not.toContain(FLOP_TREE_ASSUMPTION);
    }
  });

  it("flop spots: simplified tree (50% / 75% / 75%, no raises)", () => {
    const { spot, assumptions } = run();
    expect(spot.betSizes).toEqual({
      flop: { bet: "50%", raise: "" },
      turn: { bet: "75%", raise: "" },
      river: { bet: "75%", raise: "" },
    });
    expect(assumptions).toContain(FLOP_TREE_ASSUMPTION);
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
    expect(turn.assumptions).toContain("Assumed raises of 3x");

    const flop = run({ bet_sizes: { bet: "50%", raise: null } });
    expect(flop.spot.betSizes.flop).toEqual({ bet: "50%", raise: "" });
    expect(flop.assumptions).toContain("Assumed no raises to keep the flop tree small");
  });

  it("user raise only -> default bets", () => {
    const river = run({ board: "Td9d6hQc2s", bet_sizes: { bet: null, raise: "4x" } });
    expect(river.spot.betSizes.river).toEqual({ bet: "33%, 75%, a", raise: "4x" });

    const flop = run({ bet_sizes: { bet: null, raise: "4x" } });
    expect(flop.spot.betSizes.flop).toEqual({ bet: "50%", raise: "4x" });
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
