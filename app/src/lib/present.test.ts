import { describe, expect, it } from "vitest";
import { describeStreetSizes } from "./present";

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
