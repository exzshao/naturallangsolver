// HTTP client for the Rust solver service (SPEC §7). Never throws: every
// failure maps to a §6 "can't solve" response with the app's user-facing
// message (the solver's own detail stays in the server log).
//
// When SOLVER_API_KEY is set, every call sends it as `x-solver-key`. A 401
// from the solver means the key is misconfigured; users see SOLVER_UNAVAILABLE.
//
// With `onStatus`, /solve is asked for NDJSON (SPEC §7) and queue/solving
// status lines are passed through as they arrive.
import { isNdjson, NDJSON, parseLine, readLines, type StatusEvent } from "./stream";
import type { CantSolveReason, CantSolveResponse, SolverRequest, SolverResponse } from "./types";
import { CANT_SOLVE_REASONS } from "./types";
import { cantSolve } from "./validate";

/**
 * Up to QUEUE_MAX_WAIT_SECS (120) in the solver queue plus SOLVE_TIMEOUT_SECS
 * (90) solving, plus tree building, transfer, and a cold start.
 */
export const SOLVER_TIMEOUT_MS = 250_000;
/** /admit is instant once the machine is up; leave room for a cold start. */
export const ADMIT_TIMEOUT_MS = 20_000;

export type SolverClientOptions = {
  url?: string;
  timeoutMs?: number;
  apiKey?: string;
  /** Aborts the request (e.g. the browser went away), which frees the solver queue slot. */
  signal?: AbortSignal;
};

export type SolveCallOptions = SolverClientOptions & {
  /** Receives queue position / solving updates; switches the request to NDJSON. */
  onStatus?: (event: StatusEvent) => void;
};

function solverHeaders(apiKey = process.env.SOLVER_API_KEY): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-solver-key"] = apiKey;
  return headers;
}

/**
 * Asks the solver's rate limiter whether this client may run a solve. Call it
 * before the LLM so refused requests cost nothing. Returns null when admitted,
 * RATE_LIMITED on 429, and fails closed (SOLVER_UNAVAILABLE) on anything else.
 */
export async function admitSolve(
  ip: string,
  { url = process.env.SOLVER_URL, timeoutMs = ADMIT_TIMEOUT_MS, apiKey }: SolverClientOptions = {},
): Promise<CantSolveResponse | null> {
  if (!url) {
    console.error("[solver] SOLVER_URL is not set");
    return cantSolve("SOLVER_UNAVAILABLE");
  }
  let res: Response;
  try {
    res = await fetch(new URL("/admit", url), {
      method: "POST",
      headers: solverHeaders(apiKey),
      body: JSON.stringify({ ip }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    console.error("[solver] /admit failed:", err);
    return cantSolve("SOLVER_UNAVAILABLE");
  }
  if (res.ok) return null;
  if (res.status === 429) {
    console.warn(`[solver] rate limited: ${ip}`);
    return cantSolve("RATE_LIMITED");
  }
  console.error(`[solver] /admit returned ${res.status}${res.status === 401 ? " (check SOLVER_API_KEY)" : ""}`);
  return cantSolve("SOLVER_UNAVAILABLE");
}

function isReason(x: unknown): x is CantSolveReason {
  return typeof x === "string" && (CANT_SOLVE_REASONS as readonly string[]).includes(x);
}

function reasonForStatus(status: number): CantSolveReason {
  if (status === 401) return "SOLVER_UNAVAILABLE";
  if (status === 503) return "SOLVER_BUSY";
  if (status === 504) return "TIMEOUT";
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  return "INTERNAL";
}

function interpret(status: number, ok: boolean, body: unknown): SolverResponse {
  const b = (body ?? {}) as Record<string, unknown>;
  if (ok && b.status === "ok" && Array.isArray(b.nodes) && b.players) {
    return body as SolverResponse;
  }
  if (b.status === "cant_solve" && isReason(b.reason)) {
    console.warn(`[solver] ${status} ${b.reason}: ${String(b.message ?? "")}`);
    return cantSolve(b.reason);
  }
  console.error(`[solver] unexpected ${status} response${status === 401 ? " (check SOLVER_API_KEY)" : ""}:`, body);
  return cantSolve(ok ? "INTERNAL" : reasonForStatus(status));
}

function failure(err: unknown, timeoutMs: number, what: string): CantSolveResponse {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError") {
    console.error(`[solver] no response within ${timeoutMs}ms`);
    return cantSolve("TIMEOUT");
  }
  if (name === "AbortError") {
    console.warn(`[solver] ${what} aborted by the caller`);
    return cantSolve("INTERNAL");
  }
  console.error(`[solver] ${what} failed:`, err);
  return cantSolve("SOLVER_UNAVAILABLE");
}

async function readStream(
  res: Response,
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
  onStatus?: (event: StatusEvent) => void,
): Promise<SolverResponse> {
  try {
    for await (const line of readLines(body)) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (parsed.kind === "status") onStatus?.(parsed.event);
      else return interpret(res.status, res.ok, parsed.body);
    }
  } catch (err) {
    return failure(err, timeoutMs, "/solve stream");
  }
  console.error("[solver] /solve stream ended without a result");
  return cantSolve("SOLVER_UNAVAILABLE");
}

export async function callSolver(
  request: SolverRequest,
  { url = process.env.SOLVER_URL, timeoutMs = SOLVER_TIMEOUT_MS, apiKey, signal, onStatus }: SolveCallOptions = {},
): Promise<SolverResponse> {
  if (!url) {
    console.error("[solver] SOLVER_URL is not set");
    return cantSolve("SOLVER_UNAVAILABLE");
  }

  const headers = solverHeaders(apiKey);
  if (onStatus) headers.accept = NDJSON;
  const timeout = AbortSignal.timeout(timeoutMs);

  let res: Response;
  try {
    res = await fetch(new URL("/solve", url), {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      cache: "no-store",
    });
  } catch (err) {
    return failure(err, timeoutMs, "request");
  }

  // Errors before the stream starts (bad input, queue full, auth) are plain JSON.
  if (isNdjson(res) && res.body) return readStream(res, res.body, timeoutMs, onStatus);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return interpret(res.status, res.ok, body);
}
