import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SolveOkPayload } from "@/lib/present";
import { extraction } from "@/lib/test-helpers";
import type { SolverOkResponse } from "@/lib/types";
import { CANT_SOLVE_MESSAGES } from "@/lib/validate";

// Mock the LLM: keep the real error class, replace extraction.
vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return { ...actual, extractSpot: vi.fn() };
});

const { extractSpot, LlmUnavailableError } = await import("@/lib/llm");
const { POST } = await import("./route");
const mockExtract = vi.mocked(extractSpot);

// Mock the solver at the network layer so solver.ts's mapping is exercised.
const fetchMock = vi.fn<typeof fetch>();

const SOLVER_OK: SolverOkResponse = {
  status: "ok",
  exploitability_pct: 0.42,
  iterations: 340,
  solve_ms: 6900,
  memory_mb: 520,
  compressed: false,
  players: { oop: { equity: 0.47, ev: 252.1 }, ip: { equity: 0.53, ev: 297.9 } },
  nodes: [
    {
      line: [],
      player: "oop",
      actions: [
        {
          action: "Check",
          amount: 0,
          frequency: 0.71,
          top_hands: ["QJs", "88"],
          top_classes: [
            { hand: "QJs", frequency: 0.72 },
            { hand: "88", frequency: 1 },
          ],
        },
        { action: "Bet", amount: 275, frequency: 0.29, top_hands: ["87s"], top_classes: [{ hand: "87s", frequency: 0.9 }] },
      ],
    },
    {
      line: ["Check"],
      player: "ip",
      actions: [
        { action: "Check", amount: 0, frequency: 0.4, top_hands: [], top_classes: [] },
        { action: "Bet", amount: 275, frequency: 0.6, top_hands: ["AKs"], top_classes: [{ hand: "AKs", frequency: 0.64 }] },
      ],
    },
  ],
  hero_hand: {
    hand: "AhKh",
    node: 1,
    equity: 0.61,
    ev: 410.2,
    actions: [
      { action: "Check", amount: 0, frequency: 0.36 },
      { action: "Bet", amount: 275, frequency: 0.64 },
    ],
  },
};

const SPEC_EXAMPLE = extraction({
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

function solverReplies(status: number, body: unknown) {
  fetchMock.mockResolvedValue(Response.json(body, { status }));
}

function solverError(status: number, reason: string) {
  solverReplies(status, { status: "cant_solve", reason, message: "solver detail" });
}

async function post(body: unknown) {
  const res = await POST(
    new Request("http://localhost/api/solve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.stubEnv("SOLVER_URL", "http://solver.test");
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  mockExtract.mockReset();
});

describe("POST /api/solve", () => {
  it("returns strategy, assumptions, and notes for the §1 example", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverReplies(200, SOLVER_OK);

    const { status, body } = await post({ text: "BTN vs BB single raised pot, 100bb deep, flop Td9d6h ..." });
    expect(status).toBe(200);
    const ok = body as SolveOkPayload;
    expect(ok.status).toBe("ok");
    expect(ok.assumptions.length).toBeGreaterThan(0);
    expect(ok.notes).toBe("BB checks to hero.");
    expect(ok.spot).toMatchObject({ board: "Td9d6h", heroPosition: "BTN", oopPosition: "BB", potBb: 5.5 });
    // chips -> bb and % of pot
    expect(ok.nodes[0]).toMatchObject({ title: "BB acts first", position: "BB", isHero: false });
    expect(ok.nodes[1].title).toBe("BTN after BB checks");
    expect(ok.nodes[1].actions[1]).toMatchObject({ label: "Bet 2.75bb", amountBb: 2.75, potPct: 50, frequency: 0.6 });
    expect(ok.players.ip).toEqual({ position: "BTN", equity: 0.53, evBb: 2.98 });
    expect(ok.heroHand).toMatchObject({
      hand: "AhKh",
      nodeTitle: "BTN after BB checks",
      situation: "when BB checks",
      evBb: 4.1,
    });
    expect(ok.nodes[0].actions[0].topClasses).toEqual([
      { hand: "QJs", frequency: 0.72 },
      { hand: "88", frequency: 1 },
    ]);
    expect(ok.nodes[1].actions[0].topClasses).toEqual([]);
    expect(ok.heroHand?.actions[0].topClasses).toEqual([]);
    expect(ok.stats.exploitabilityPct).toBe(0.42);

    // The solver got the defaulted request in chips.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://solver.test/solve");
    const sent = JSON.parse(String(init?.body));
    expect(sent).toMatchObject({ board: "Td9d6h", starting_pot: 550, effective_stack: 9750, hero: { player: "ip", hand: "AhKh" } });
  });

  it.each([
    ["NOT_POKER", extraction({ is_poker_spot: false, board: null })],
    ["MULTIWAY", extraction({ num_players: 3 })],
    ["PREFLOP", extraction({ street: "preflop", board: null })],
    ["INVALID_BOARD", extraction({ board: "Td9dTd" })],
  ])("returns %s from app-side validation without calling the solver", async (reason, x) => {
    mockExtract.mockResolvedValue(x);
    const { status, body } = await post({ text: "some spot" });
    expect(status).toBe(422);
    expect(body).toEqual({ status: "cant_solve", reason, message: CANT_SOLVE_MESSAGES[reason as keyof typeof CANT_SOLVE_MESSAGES] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["TREE_TOO_LARGE", 422, 422],
    ["INVALID_BOARD", 422, 422],
    ["INVALID_RANGE", 422, 422],
    ["SOLVER_BUSY", 503, 503],
    ["TIMEOUT", 504, 504],
    ["INTERNAL", 500, 500],
  ])("maps solver %s (%i) to a can't-solve response (%i)", async (reason, solverStatus, appStatus) => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverError(solverStatus, reason);
    const { status, body } = await post({ text: "deep flop with every size" });
    expect(status).toBe(appStatus);
    expect(body.status).toBe("cant_solve");
    expect(body.reason).toBe(reason);
    // App's own message, not the solver's detail.
    expect(body.message).toBe(CANT_SOLVE_MESSAGES[reason as keyof typeof CANT_SOLVE_MESSAGES]);
  });

  it("maps a non-JSON 503 from the solver to SOLVER_BUSY", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    fetchMock.mockResolvedValue(new Response("busy", { status: 503 }));
    const { body } = await post({ text: "spot" });
    expect(body.reason).toBe("SOLVER_BUSY");
  });

  it("returns SOLVER_UNAVAILABLE when the solver is down", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const { status, body } = await post({ text: "spot" });
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "cant_solve", reason: "SOLVER_UNAVAILABLE" });
  });

  it("returns SOLVER_UNAVAILABLE when SOLVER_URL is unset", async () => {
    vi.stubEnv("SOLVER_URL", "");
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    const { body } = await post({ text: "spot" });
    expect(body.reason).toBe("SOLVER_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns TIMEOUT when the solver doesn't answer in time", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const { status, body } = await post({ text: "spot" });
    expect(status).toBe(504);
    expect(body.reason).toBe("TIMEOUT");
  });

  it("returns LLM_UNAVAILABLE when extraction fails", async () => {
    mockExtract.mockRejectedValue(new LlmUnavailableError("401 Unauthorized"));
    const { status, body } = await post({ text: "BTN vs BB, flop Td9d6h" });
    expect(status).toBe(503);
    expect(body).toEqual({
      status: "cant_solve",
      reason: "LLM_UNAVAILABLE",
      message: CANT_SOLVE_MESSAGES.LLM_UNAVAILABLE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing text", {}],
    ["blank text", { text: "   " }],
    ["non-string text", { text: 42 }],
    ["oversized text", { text: "x".repeat(2001) }],
    ["invalid JSON", "{not json"],
  ])("rejects %s with 400 INVALID_REQUEST", async (_, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: "cant_solve", reason: "INVALID_REQUEST" });
    expect(mockExtract).not.toHaveBeenCalled();
  });
});
