// POST /api/solve  { text: string }
// extract (LLM) -> defaults + validate (pure) -> solver -> SolveApiResponse.
// Every failure is a §6 "can't solve" body; the HTTP status mirrors the
// solver's convention (422 input problems, 503 busy/unavailable, 504 timeout).
import { extractSpot, LlmUnavailableError } from "@/lib/llm";
import { presentResult, type SolveApiResponse } from "@/lib/present";
import { prepareSolve } from "@/lib/request";
import { callSolver } from "@/lib/solver";
import type { CantSolveReason, CantSolveResponse } from "@/lib/types";
import { cantSolve } from "@/lib/validate";

const MAX_INPUT_CHARS = 2000;

const HTTP_STATUS: Partial<Record<CantSolveReason, number>> = {
  INVALID_REQUEST: 400,
  SOLVER_BUSY: 503,
  LLM_UNAVAILABLE: 503,
  SOLVER_UNAVAILABLE: 503,
  TIMEOUT: 504,
  INTERNAL: 500,
};

function reply(body: SolveApiResponse): Response {
  const status = body.status === "ok" ? 200 : (HTTP_STATUS[body.reason] ?? 422);
  return Response.json(body, { status });
}

function badInput(message: string): Response {
  return reply(cantSolve("INVALID_REQUEST", message));
}

export async function POST(req: Request): Promise<Response> {
  let text: unknown;
  try {
    text = ((await req.json()) as { text?: unknown } | null)?.text;
  } catch {
    return badInput("Can't solve this: the request body must be JSON like {\"text\": \"...\"}.");
  }
  if (typeof text !== "string" || text.trim() === "") {
    return badInput("Can't solve this: describe a poker spot to solve.");
  }
  if (text.length > MAX_INPUT_CHARS) {
    return badInput(`Can't solve this: keep the description under ${MAX_INPUT_CHARS} characters.`);
  }

  let extraction;
  try {
    extraction = await extractSpot(text.trim());
  } catch (err) {
    console.error("[api/solve] extraction failed:", err instanceof Error ? err.message : err);
    return reply(cantSolve(err instanceof LlmUnavailableError ? "LLM_UNAVAILABLE" : "INTERNAL"));
  }

  const prepared = prepareSolve(extraction);
  if (!prepared.ok) return reply(prepared.error);

  const result = await callSolver(prepared.request);
  if (result.status !== "ok") return reply(result satisfies CantSolveResponse);

  return reply(
    presentResult(result, prepared.spot, prepared.assumptions, extraction.notes, prepared.request.starting_pot),
  );
}
