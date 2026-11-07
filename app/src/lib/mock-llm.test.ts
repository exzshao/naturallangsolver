import { describe, expect, it } from "vitest";
import { extractSpot, resolveModel } from "./llm";
import { mockExtraction } from "./mock-llm";
import { prepareSolve } from "./request";

const SPEC_EXAMPLE =
  "BTN vs BB single raised pot, 100bb deep, flop Td9d6h, I'm on the button with AhKh, BB checks to me.";

describe("mock:fixture LLM", () => {
  it("extracts the §1 example", () => {
    expect(mockExtraction(SPEC_EXAMPLE)).toMatchObject({
      is_poker_spot: true,
      num_players: 2,
      street: "flop",
      board: "Td9d6h",
      hero_position: "BTN",
      villain_position: "BB",
      hero_hand: "AhKh",
      pot_type: "srp",
      starting_stack_bb: 100,
      notes: "BB checks to hero.",
    });
  });

  it.each([
    ["what's the capital of France", "NOT_POKER"],
    ["3-way pot, flop Td9d6h, BTN vs CO vs BB", "MULTIWAY"],
    ["preflop: I open AKo from the button, BB 3-bets", "PREFLOP"],
    ["BTN vs BB, flop Td9dTd, I have AhKh", "INVALID_BOARD"],
  ])("%s -> %s", (text, reason) => {
    const r = prepareSolve(mockExtraction(text));
    expect(r.ok ? null : r.error.reason).toBe(reason);
  });

  it("routes the many-sizes prompt to a deep flop with a big tree", () => {
    const r = prepareSolve(mockExtraction("200bb deep flop Td9d6h with every size"));
    expect(r.ok && r.request.bet_sizes.flop.bet.split(",").length).toBe(3);
  });

  it("works end to end through generateText via the registry", async () => {
    const x = await extractSpot("river Td9d6hQc2s, I'm in the BB with KhQh vs BTN", resolveModel("mock:fixture"));
    expect(x).toMatchObject({ board: "Td9d6hQc2s", street: "river", hero_position: "BB", villain_position: "BTN", hero_hand: "KhQh" });
  });
});
