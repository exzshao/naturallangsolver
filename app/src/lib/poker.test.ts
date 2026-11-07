import { describe, expect, it } from "vitest";
import {
  bbToChips,
  chipsToBb,
  handWeightInRange,
  heroPlayer,
  orderPositions,
  parseCards,
  parseHand,
} from "./poker";

describe("bb <-> chips (1bb = 100 chips)", () => {
  it.each([
    [5.5, 550],
    [97.5, 9750],
    [100, 10000],
    [0.333, 33],
    [0.125, 13],
    [20, 2000],
  ])("%sbb -> %s chips", (bb, chips) => {
    expect(bbToChips(bb)).toBe(chips);
  });

  it("converts chips back to bb", () => {
    expect(chipsToBb(550)).toBe(5.5);
    expect(chipsToBb(9750)).toBe(97.5);
    expect(chipsToBb(bbToChips(77.5))).toBe(77.5);
  });
});

describe("OOP/IP ordering (SB, BB, UTG, HJ, CO, BTN)", () => {
  it.each([
    ["BTN", "BB", "BB", "BTN"],
    ["BB", "BTN", "BB", "BTN"],
    ["SB", "BB", "SB", "BB"],
    ["BTN", "SB", "SB", "BTN"],
    ["CO", "BTN", "CO", "BTN"],
    ["UTG", "HJ", "UTG", "HJ"],
    ["BB", "UTG", "BB", "UTG"],
    ["HJ", "SB", "SB", "HJ"],
  ] as const)("%s vs %s -> OOP %s, IP %s", (a, b, oop, ip) => {
    expect(orderPositions(a, b)).toEqual({ oop, ip });
  });

  it("hero can be either seat", () => {
    expect(heroPlayer("BTN", "BB")).toBe("ip");
    expect(heroPlayer("BB", "BTN")).toBe("oop");
    expect(heroPlayer("SB", "BB")).toBe("oop");
  });
});

describe("card parsing", () => {
  it("normalizes boards", () => {
    expect(parseCards("Td9d6h")).toEqual(["Td", "9d", "6h"]);
    expect(parseCards("td 9D 6h")).toEqual(["Td", "9d", "6h"]);
    expect(parseCards("10d9d6h")).toEqual(["Td", "9d", "6h"]);
    expect(parseCards("Td,9d,6h,Qc")).toEqual(["Td", "9d", "6h", "Qc"]);
  });

  it("rejects malformed boards", () => {
    expect(parseCards("Tx9d6h")).toBeNull();
    expect(parseCards("Td9d6")).toBeNull();
    expect(parseCards("")).toBeNull();
  });

  it("normalizes hands with the higher card first", () => {
    expect(parseHand("AhKh")).toBe("AhKh");
    expect(parseHand("KhAh")).toBe("AhKh");
    expect(parseHand("AhAs")).toBe("AsAh");
    expect(parseHand("AK")).toBeNull();
    expect(parseHand("AhAh")).toBeNull();
  });
});

describe("handWeightInRange", () => {
  it("handles singletons, plus, and dash ranges", () => {
    expect(handWeightInRange("AKs", "AhKh")).toBe(1);
    expect(handWeightInRange("AKs", "AhKd")).toBe(0);
    expect(handWeightInRange("AKo", "AhKd")).toBe(1);
    expect(handWeightInRange("AK", "AhKd")).toBe(1);
    expect(handWeightInRange("TT+", "QsQh")).toBe(1);
    expect(handWeightInRange("TT+", "9s9h")).toBe(0);
    expect(handWeightInRange("A2s+", "Ah5h")).toBe(1);
    expect(handWeightInRange("T9s+", "QhJh")).toBe(1);
    expect(handWeightInRange("T9s+", "9h8h")).toBe(0);
    expect(handWeightInRange("JJ-22", "QhQd")).toBe(0);
    expect(handWeightInRange("JJ-22", "5h5d")).toBe(1);
    // ascending order is accepted (the solver service flips it)
    expect(handWeightInRange("22-JJ", "5h5d")).toBe(1);
    expect(handWeightInRange("A2s-AJs", "AhTh")).toBe(1);
    expect(handWeightInRange("A2s-AJs", "AhQh")).toBe(0);
    expect(handWeightInRange("A9s-A6s", "Ah7h")).toBe(1);
    expect(handWeightInRange("A9s-A6s", "AhTh")).toBe(0);
    expect(handWeightInRange("AsAh", "AhAs")).toBe(1);
    expect(handWeightInRange(" QQ+ , AKs ", "AhKh")).toBe(1);
  });

  it("uses the first matching group's weight, like postflop-solver", () => {
    expect(handWeightInRange("AKs:0.5,AK", "AhKh")).toBe(0.5);
    expect(handWeightInRange("AKs:0,AK", "AhKh")).toBe(0);
    expect(handWeightInRange("AK,AKs:0", "AhKh")).toBe(1);
  });

  it("returns null for unparseable ranges", () => {
    expect(handWeightInRange("garbage", "AhKh")).toBeNull();
    expect(handWeightInRange("AAs", "AhKh")).toBeNull();
    expect(handWeightInRange("AKs-QQ", "AhKh")).toBeNull();
  });
});
