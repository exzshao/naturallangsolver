// HTTP client for the Rust solver service (SPEC §7). Never throws: every
// failure maps to a §6 "can't solve" response with the app's user-facing
// message (the solver's own detail stays in the server log).
import type { CantSolveReason, SolverRequest, SolverResponse } from "./types";
import { CANT_SOLVE_REASONS } from "./types";
import { cantSolve } from "./validate";

/** The solver gives up after SOLVE_TIMEOUT_SECS (default 90); allow for tree building and transfer. */
export const SOLVER_TIMEOUT_MS = 120_000;

export type SolverClientOptions = {
  url?: string;
  timeoutMs?: number;
};

function isReason(x: unknown): x is CantSolveReason {
  return typeof x === "string" && (CANT_SOLVE_REASONS as readonly string[]).includes(x);
}

function reasonForStatus(status: number): CantSolveReason {
  if (status === 503) return "SOLVER_BUSY";
  if (status === 504) return "TIMEOUT";
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  return "INTERNAL";
}

export async function callSolver(
  request: SolverRequest,
  { url = process.env.SOLVER_URL, timeoutMs = SOLVER_TIMEOUT_MS }: SolverClientOptions = {},
): Promise<SolverResponse> {
  if (!url) {
    console.error("[solver] SOLVER_URL is not set");
    return cantSolve("SOLVER_UNAVAILABLE");
  }

  let res: Response;
  try {
    res = await fetch(new URL("/solve", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      console.error(`[solver] no response within ${timeoutMs}ms`);
      return cantSolve("TIMEOUT");
    }
    console.error("[solver] request failed:", err);
    return cantSolve("SOLVER_UNAVAILABLE");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (res.ok && b.status === "ok" && Array.isArray(b.nodes) && b.players) {
    return body as SolverResponse;
  }
  if (b.status === "cant_solve" && isReason(b.reason)) {
    console.warn(`[solver] ${res.status} ${b.reason}: ${String(b.message ?? "")}`);
    return cantSolve(b.reason);
  }
  console.error(`[solver] unexpected ${res.status} response:`, body);
  return cantSolve(res.ok ? "INTERNAL" : reasonForStatus(res.status));
}
