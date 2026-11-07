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

// The route calls the solver twice: POST /admit (rate limit), then POST /solve.
type Reply = () => Promise<Response>;
let admitReply: Reply;
let solveReply: Reply;

const callsTo = (path: string) => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === path);

function solverReplies(status: number, body: unknown) {
  solveReply = async () => Response.json(body, { status });
}

function solverRaw(res: Response) {
  solveReply = async () => res;
}

function solverRejects(err: unknown) {
  solveReply = async () => {
    throw err;
  };
}

function solverError(status: number, reason: string) {
  solverReplies(status, { status: "cant_solve", reason, message: "solver detail" });
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await POST(
    new Request("http://localhost/api/solve", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.stubEnv("SOLVER_URL", "http://solver.test");
  vi.stubEnv("SOLVER_API_KEY", "");
  admitReply = async () => Response.json({ status: "ok" });
  solveReply = async () => {
    throw new Error("unexpected /solve call");
  };
  fetchMock.mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/admit") return admitReply();
    if (path === "/solve") return solveReply();
    throw new Error(`unexpected fetch ${String(url)}`);
  });
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
    expect(callsTo("/admit")).toHaveLength(1);
    const [url, init] = callsTo("/solve")[0];
    expect(String(url)).toBe("http://solver.test/solve");
    expect(new Headers(init?.headers).has("x-solver-key")).toBe(false);
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
    expect(callsTo("/solve")).toHaveLength(0);
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
    solverRaw(new Response("busy", { status: 503 }));
    const { body } = await post({ text: "spot" });
    expect(body.reason).toBe("SOLVER_BUSY");
  });

  it("returns SOLVER_UNAVAILABLE when the solver is down", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverRejects(new TypeError("fetch failed"));
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
    solverRejects(new DOMException("timed out", "TimeoutError"));
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
    expect(callsTo("/solve")).toHaveLength(0);
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
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("rate limiting and solver auth", () => {
  it("sends the client IP to /admit before extracting", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverReplies(200, SOLVER_OK);
    const { status } = await post({ text: "spot" }, { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "x-real-ip": "10.9.9.9" });
    expect(status).toBe(200);
    const [url, init] = callsTo("/admit")[0];
    expect(String(url)).toBe("http://solver.test/admit");
    expect(JSON.parse(String(init?.body))).toEqual({ ip: "203.0.113.7" });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(mockExtract.mock.invocationCallOrder[0]);
  });

  it.each([
    [{ "x-real-ip": "198.51.100.4" }, "198.51.100.4"],
    [{}, "unknown"],
  ])("falls back for the client IP (%o)", async (headers, ip) => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverReplies(200, SOLVER_OK);
    await post({ text: "spot" }, headers);
    expect(JSON.parse(String(callsTo("/admit")[0][1]?.body))).toEqual({ ip });
  });

  it("returns RATE_LIMITED (429) without calling the LLM when /admit refuses", async () => {
    admitReply = async () =>
      Response.json({ status: "cant_solve", reason: "RATE_LIMITED", message: "x" }, { status: 429 });
    const { status, body } = await post({ text: "spot" });
    expect(status).toBe(429);
    expect(body).toEqual({ status: "cant_solve", reason: "RATE_LIMITED", message: CANT_SOLVE_MESSAGES.RATE_LIMITED });
    expect(body.message).toBe("Can't solve this: too many solves. Try again later.");
    expect(mockExtract).not.toHaveBeenCalled();
    expect(callsTo("/solve")).toHaveLength(0);
  });

  it.each([
    ["unreachable", async () => Promise.reject(new TypeError("fetch failed"))],
    ["timing out", async () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    ["returning 500", async () => new Response("oops", { status: 500 })],
    ["rejecting the key (401)", async () => Response.json({ status: "cant_solve", reason: "UNAUTHORIZED" }, { status: 401 })],
  ])("fails closed with SOLVER_UNAVAILABLE when /admit is %s", async (_, reply) => {
    admitReply = reply;
    const { status, body } = await post({ text: "spot" });
    expect(status).toBe(503);
    expect(body.reason).toBe("SOLVER_UNAVAILABLE");
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("sends x-solver-key on /admit and /solve when SOLVER_API_KEY is set", async () => {
    vi.stubEnv("SOLVER_API_KEY", "s3cret");
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverReplies(200, SOLVER_OK);
    await post({ text: "spot" });
    for (const path of ["/admit", "/solve"]) {
      expect(new Headers(callsTo(path)[0][1]?.headers).get("x-solver-key")).toBe("s3cret");
    }
  });

  it("maps a 401 from /solve to SOLVER_UNAVAILABLE", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverError(401, "UNAUTHORIZED");
    const { status, body } = await post({ text: "spot" });
    expect(status).toBe(503);
    expect(body.reason).toBe("SOLVER_UNAVAILABLE");
  });
});

describe("streaming (Accept: application/x-ndjson)", () => {
  const NDJSON_HEADERS = { "content-type": "application/x-ndjson" };

  function ndjsonBody(lines: unknown[], { hang = false, signal }: { hang?: boolean; signal?: AbortSignal } = {}) {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
        if (!hang) c.close();
        signal?.addEventListener("abort", () => c.error(signal.reason));
      },
    });
  }

  function solverStreams(lines: unknown[]) {
    solveReply = async () => new Response(ndjsonBody(lines), { headers: NDJSON_HEADERS });
  }

  async function postStream(body: unknown) {
    const res = await POST(
      new Request("http://localhost/api/solve", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    return { res, events };
  }

  it("relays queue positions and solving, then the rendered result", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverStreams([
      { type: "queued", position: 2 },
      { type: "queued", position: 2 },
      { type: "queued", position: 1 },
      { type: "solving" },
      { type: "result", ...SOLVER_OK },
    ]);
    const { res, events } = await postStream({ text: "flop spot" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    expect(events.slice(0, -1)).toEqual([
      { type: "queued", position: 2 },
      { type: "queued", position: 2 },
      { type: "queued", position: 1 },
      { type: "solving" },
    ]);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "result", status: "ok", spot: { board: "Td9d6h", heroPosition: "BTN" } });
    expect(last.nodes[1].actions[1]).toMatchObject({ label: "Bet 2.75bb", frequency: 0.6 });

    const [, init] = callsTo("/solve")[0];
    expect(new Headers(init?.headers).get("accept")).toBe("application/x-ndjson");
  });

  it("ends with the app's message when the solver's queue times out", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverStreams([
      { type: "queued", position: 1 },
      { type: "error", status: "cant_solve", reason: "SOLVER_BUSY", message: "queue timed out" },
    ]);
    const { res, events } = await postStream({ text: "flop spot" });
    expect(res.status).toBe(200);
    expect(events.map((e) => e.type)).toEqual(["queued", "error"]);
    expect(events[1]).toEqual({ type: "error", ...cantSolveBody("SOLVER_BUSY") });
  });

  it("maps a plain 503 (queue full, before any stream) to a final error line", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverError(503, "SOLVER_BUSY");
    const { events } = await postStream({ text: "flop spot" });
    expect(events).toEqual([{ type: "error", ...cantSolveBody("SOLVER_BUSY") }]);
  });

  it("streams app-side validation failures without calling the solver", async () => {
    mockExtract.mockResolvedValue(extraction({ street: "preflop", board: null }));
    const { res, events } = await postStream({ text: "preflop" });
    expect(res.status).toBe(200);
    expect(events).toEqual([{ type: "error", ...cantSolveBody("PREFLOP") }]);
    expect(callsTo("/solve")).toHaveLength(0);
  });

  it("returns SOLVER_UNAVAILABLE when the solver stream ends without a result", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverStreams([{ type: "queued", position: 1 }, { type: "solving" }]);
    const { events } = await postStream({ text: "flop spot" });
    expect(events.at(-1)).toEqual({ type: "error", ...cantSolveBody("SOLVER_UNAVAILABLE") });
  });

  it("keeps plain JSON errors for bad input and rate limits", async () => {
    const bad = await POST(
      new Request("http://localhost/api/solve", {
        method: "POST",
        headers: { accept: "application/x-ndjson" },
        body: JSON.stringify({ text: " " }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toContain("application/json");

    admitReply = async () => Response.json({ status: "cant_solve", reason: "RATE_LIMITED" }, { status: 429 });
    const limited = await POST(
      new Request("http://localhost/api/solve", {
        method: "POST",
        headers: { accept: "application/x-ndjson" },
        body: JSON.stringify({ text: "spot" }),
      }),
    );
    expect(limited.status).toBe(429);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("aborts the solver request when the browser cancels the stream", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    let solverSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/admit") return admitReply();
      solverSignal = init?.signal ?? undefined;
      return new Response(ndjsonBody([{ type: "queued", position: 3 }], { hang: true, signal: solverSignal }), {
        headers: NDJSON_HEADERS,
      });
    });
    const res = await POST(
      new Request("http://localhost/api/solve", {
        method: "POST",
        headers: { accept: "application/x-ndjson" },
        body: JSON.stringify({ text: "spot" }),
      }),
    );
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = "";
    while (!seen.includes('"position":3')) seen += dec.decode((await reader.read()).value);
    expect(solverSignal?.aborted).toBe(false);
    await reader.cancel();
    expect(solverSignal?.aborted).toBe(true);
  });

  it("does not ask the solver for NDJSON on the plain JSON path", async () => {
    mockExtract.mockResolvedValue(SPEC_EXAMPLE);
    solverReplies(200, SOLVER_OK);
    await post({ text: "spot" });
    expect(new Headers(callsTo("/solve")[0][1]?.headers).has("accept")).toBe(false);
  });
});

function cantSolveBody(reason: keyof typeof CANT_SOLVE_MESSAGES) {
  return { status: "cant_solve", reason, message: CANT_SOLVE_MESSAGES[reason] };
}
