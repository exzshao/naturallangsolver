import { describe, expect, it } from "vitest";
import { describeStreetSizes, type DisplayAction, presentAction, verdict } from "./present";
import type { HeroAction } from "./types";

/** A hero action with EV in bb (chips = bb * 100). */
const a = (action: HeroAction["action"], amountBb: number, frequency: number, evBb?: number, toCallBb = 0): DisplayAction =>
  presentAction(
    { action, amount: amountBb * 100, frequency, ev: evBb === undefined ? undefined : evBb * 100 },
    7450,
    toCallBb * 100,
  );

describe("verdict", () => {
  it("says CLOSE for a 90% bet that is 0.29bb better in a 74.5bb pot", () => {
    const v = verdict([a("Check", 0, 0.1, 74.68), a("Bet", 37, 0.9, 74.97)], 74.5);
    expect(v).toMatchObject({ kind: "close", gapBb: 0.29 });
    expect(v?.text).toBe("CLOSE: EITHER BET 37bb OR CHECK IS FINE (0.29bb APART)");
  });

  it("says CLOSE regardless of frequencies when EVs are near-equal", () => {
    const v = verdict([a("Check", 0, 0.98, 10.2), a("Bet", 2.75, 0.02, 10.25)], 5.5);
    expect(v?.kind).toBe("close");
    // The tie goes to the more frequent action, which is named first.
    expect(v?.text).toBe("CLOSE: EITHER CHECK OR BET 2.75bb IS FINE (0.05bb APART)");
  });

  it("lists every action within the close band", () => {
    const v = verdict([a("Check", 0, 0.3, 20), a("Bet", 10, 0.4, 20.3), a("Bet", 40, 0.3, 20.1), a("AllIn", 90, 0, 12)], 40);
    expect(v?.text).toBe("CLOSE: BET 10bb, BET 40bb OR CHECK ARE ALL FINE (WITHIN 0.3bb)");
  });

  it("says SLIGHT EDGE between 1% and 5% of pot", () => {
    const v = verdict([a("Check", 0, 0.5, 18), a("Bet", 10, 0.5, 19)], 40);
    expect(v).toMatchObject({ kind: "slight", gapBb: 1, gapPot: 0.025 });
    expect(v?.text).toBe("SLIGHT EDGE: BET 10bb (+1bb OVER CHECK)");
  });

  it("says CLEAR above 5% of pot (the 72o call)", () => {
    const v = verdict([a("Fold", 0, 0, 0), a("Call", 0, 1, 32.32, 97.5)], 200.5);
    expect(v).toMatchObject({ kind: "clear", gapBb: 32.32 });
    expect(v?.text).toBe("CLEAR: CALL 97.5bb (+32.32bb OVER FOLD)");
  });

  it("uses the 0.1bb tie floor in small pots", () => {
    // 1% of 5.5bb is 0.055bb; a 0.08bb gap is still a tie.
    expect(verdict([a("Check", 0, 0.5, 3), a("Bet", 2.75, 0.5, 3.08)], 5.5)?.kind).toBe("close");
    expect(verdict([a("Check", 0, 0.5, 3), a("Bet", 2.75, 0.5, 3.2)], 5.5)?.kind).toBe("slight");
  });

  it("is null for a single legal action, missing EVs, or no pot", () => {
    expect(verdict([a("Check", 0, 1, 5)], 10)).toBeNull();
    expect(verdict([a("Check", 0, 0.5), a("Bet", 5, 0.5)], 10)).toBeNull();
    expect(verdict([a("Check", 0, 0.5, 5), a("Bet", 5, 0.5)], 10)).toBeNull();
    expect(verdict([a("Check", 0, 0.5, 5), a("Bet", 5, 0.5, 6)], 0)).toBeNull();
  });
});

describe("describeStreetSizes", () => {
  it("shows one line when both players have the same options", () => {
    expect(describeStreetSizes({ bet: "75%", raise: "", donk: "" }, "BB", "BTN")).toBe("75%; NO RAISE");
  });

  it("splits by player when overrides differ (default flop tree)", () => {
    expect(describeStreetSizes({ bet: "33%, 75%", raise: "", oop: { bet: "", raise: "3x" } }, "BB", "BTN")).toBe(
      "BTN 33%, 75%; NO RAISE · BB NONE; RAISE 3x",
    );
  });

  it("appends the sizes the solved tree added, a bet by a player without bets as a lead", () => {
    const flop = { bet: "33%, 75%", raise: "", oop: { bet: "", raise: "3x" } };
    expect(
      describeStreetSizes(flop, "BB", "BTN", [
        { street: "flop", player: "oop", kind: "bet", allin: false, amountBb: 4, described: true },
        { street: "flop", player: "ip", kind: "raise", allin: false, amountBb: 12, described: false },
      ]),
    ).toBe("BTN 33%, 75%; NO RAISE · BB NONE; RAISE 3x · ADDED: BB LEAD 4bb, BTN RAISE TO 12bb (YOUR DECISION)");
    expect(
      describeStreetSizes({ bet: "33%, 75%", raise: "3x" }, "BB", "BTN", [
        { street: "turn", player: "oop", kind: "bet", allin: false, amountBb: 9, described: true },
        { street: "turn", player: "ip", kind: "raise", allin: true, amountBb: 93.5, described: true },
      ]),
    ).toBe("33%, 75%; RAISE 3x · ADDED: BB BET 9bb, BTN ALL-IN 93.5bb");
  });
});
