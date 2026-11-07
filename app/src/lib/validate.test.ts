import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { applyDefaults } from "./defaults";
import { extractSpot, LLM_MAX_OUTPUT_TOKENS, LlmUnavailableError, resolveModel } from "./llm";
import { extraction } from "./test-helpers";
import { CANT_SOLVE_REASONS } from "./types";
import { CANT_SOLVE_MESSAGES, cantSolve, validateExtraction, validateSpot } from "./validate";

const reasonOf = (o: Parameters<typeof extraction>[0]) => validateExtraction(extraction(o))?.reason ?? null;

describe("cant_solve shape", () => {
  it("every reason has a message", () => {
    for (const r of CANT_SOLVE_REASONS) expect(CANT_SOLVE_MESSAGES[r]).toMatch(/^Can't solve this: /);
  });

  it("matches the §6 body", () => {
    expect(cantSolve("PREFLOP")).toEqual({
      status: "cant_solve",
      reason: "PREFLOP",
      message: "Can't solve this: preflop spots aren't supported yet.",
    });
  });
});

describe("validateExtraction", () => {
  it("accepts a minimal solvable spot", () => {
    expect(validateExtraction(extraction())).toBeNull();
  });

  it("NOT_POKER when is_poker_spot is false", () => {
    expect(reasonOf({ is_poker_spot: false, board: null })).toBe("NOT_POKER");
  });

  it.each([
    [{ street: "preflop" as const }],
    [{ street: "preflop" as const, board: null }],
    [{ board: null }],
    [{ board: "  " }],
  ])("PREFLOP for %j", (o) => {
    expect(reasonOf(o)).toBe("PREFLOP");
  });

  it.each([3, 4, 1, 0])("MULTIWAY when num_players = %s", (n) => {
    expect(reasonOf({ num_players: n })).toBe("MULTIWAY");
  });

  it("heads-up or unstated player count is fine", () => {
    expect(reasonOf({ num_players: 2 })).toBeNull();
    expect(reasonOf({ num_players: null })).toBeNull();
  });

  it.each([
    ["invalid card", { board: "Tx9d6h" }],
    ["too few cards", { board: "Td9d" }],
    ["too many cards", { board: "Td9d6hQc2s3s" }],
    ["odd length", { board: "Td9d6" }],
    ["duplicate card", { board: "Td9dTd" }],
    ["street mismatch (flop with 4 cards)", { board: "Td9d6hQc", street: "flop" as const }],
    ["street mismatch (river with 3 cards)", { board: "Td9d6h", street: "river" as const }],
    ["hero hand overlaps board", { hero_hand: "TdTs" }],
  ])("INVALID_BOARD: %s", (_label, o) => {
    expect(reasonOf(o)).toBe("INVALID_BOARD");
  });

  it("board count matching the street passes", () => {
    expect(reasonOf({ board: "Td9d6hQc", street: "turn" })).toBeNull();
    expect(reasonOf({ board: "Td9d6hQc2s", street: "river" })).toBeNull();
  });

  it("malformed hero hand is not a board error (defaults drop it)", () => {
    expect(reasonOf({ hero_hand: "AK" })).toBeNull();
  });

  it.each([
    [{ pot_bb: 0 }],
    [{ pot_bb: -3 }],
    [{ effective_stack_bb: 0 }],
    [{ effective_stack_bb: -10 }],
    [{ starting_stack_bb: 0 }],
  ])("INVALID_STACKS for %j", (o) => {
    expect(reasonOf(o)).toBe("INVALID_STACKS");
  });

  it("checks run in order: NOT_POKER before PREFLOP before MULTIWAY before INVALID_BOARD", () => {
    expect(reasonOf({ is_poker_spot: false, street: "preflop" })).toBe("NOT_POKER");
    expect(reasonOf({ street: "preflop", num_players: 3 })).toBe("PREFLOP");
    expect(reasonOf({ num_players: 3, board: "Tx" })).toBe("MULTIWAY");
  });
});

describe("validateSpot", () => {
  it("INVALID_STACKS when a derived stack is not positive", () => {
    const { spot } = applyDefaults(extraction({ pot_bb: 250 }));
    expect(spot.effectiveStackBb).toBeLessThanOrEqual(0);
    expect(validateSpot(spot)?.reason).toBe("INVALID_STACKS");
  });

  it("INVALID_STACKS when the pot rounds to zero chips", () => {
    const { spot } = applyDefaults(extraction({ pot_bb: 0.001 }));
    expect(validateSpot(spot)?.reason).toBe("INVALID_STACKS");
  });

  it("passes a defaulted spot", () => {
    expect(validateSpot(applyDefaults(extraction()).spot)).toBeNull();
  });
});

describe("LLM_UNAVAILABLE", () => {
  it("unset or unknown LLM_MODEL throws LlmUnavailableError", async () => {
    expect(() => resolveModel("")).toThrow(LlmUnavailableError);
    expect(() => resolveModel("nope:model")).toThrow(LlmUnavailableError);
    vi.stubEnv("LLM_MODEL", "nope:model");
    await expect(extractSpot("hi")).rejects.toThrow(LlmUnavailableError);
    vi.unstubAllEnvs();
  });

  it("provider errors are wrapped as LlmUnavailableError", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    await expect(extractSpot("BTN vs BB on Td9d6h", model)).rejects.toThrow(LlmUnavailableError);
  });

  it("returns the parsed object on success", async () => {
    const out = extraction({ hero_position: "BTN" });
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify(out) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    await expect(extractSpot("BTN on Td9d6h", model)).resolves.toEqual(out);
    expect(model.doGenerateCalls[0].maxOutputTokens).toBe(LLM_MAX_OUTPUT_TOKENS);
  });

  it("refuses the mock model in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => resolveModel("mock:fixture")).toThrow(LlmUnavailableError);
    vi.unstubAllEnvs();
    expect(() => resolveModel("mock:fixture")).not.toThrow();
  });
});
