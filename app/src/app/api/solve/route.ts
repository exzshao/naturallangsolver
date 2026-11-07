// POST /api/solve  { text: string }
// admit (solver rate limit) -> extract (LLM) -> defaults + validate (pure)
// -> solver -> SolveApiResponse.
// Every failure is a §6 "can't solve" body; the HTTP status mirrors the
// solver's convention (422 input problems, 503 busy/unavailable, 504 timeout).
//
// With `Accept: application/x-ndjson` the response is a 200 NDJSON stream
// (SPEC §7): solver queue/solving status lines as they happen, then one final
// {"type":"result"|"error", ...SolveApiResponse} line. Bad input and /admit
// refusals still come back as plain JSON with their status codes.
import { extractSpot, LlmUnavailableError } from "@/lib/llm";
import { presentResult, type SolveApiResponse } from "@/lib/present";
import { prepareSolve } from "@/lib/request";
import { admitSolve, callSolver } from "@/lib/solver";
import { finalLine, NDJSON, ndjsonLine, type StatusEvent } from "@/lib/stream";
import type { CantSolveReason, CantSolveResponse } from "@/lib/types";
import { cantSolve } from "@/lib/validate";

const MAX_INPUT_CHARS = 2000;

// LLM (20s timeout, 1 retry) + solver queue (QUEUE_MAX_WAIT_SECS=120) + solve
// (SOLVE_TIMEOUT_SECS=90; the client gives up at 250s). Vercel uses this as
// the function's time limit; 300s is the Hobby/Fluid maximum.
export const maxDuration = 300;

const STREAM_HEADERS = {
  "content-type": `${NDJSON}; charset=utf-8`,
  // Ask proxies and CDNs not to buffer or compress the stream.
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
};

// WebKit holds back the first ~1 KB of a streamed response, so the stream opens
// with one blank padding line (parsers skip blank lines).
const PADDING = `${" ".repeat(1024)}\n`;

const HTTP_STATUS: Partial<Record<CantSolveReason, number>> = {
  INVALID_REQUEST: 400,
  SOLVER_BUSY: 503,
  RATE_LIMITED: 429,
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

/** Client IP as Vercel reports it: first x-forwarded-for entry, else x-real-ip. */
function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

function wantsNdjson(headers: Headers): boolean {
  return (headers.get("accept") ?? "").toLowerCase().includes(NDJSON);
}

/** extract -> validate -> solve. Never throws. */
async function solveText(
  text: string,
  onStatus?: (event: StatusEvent) => void,
  signal?: AbortSignal,
): Promise<SolveApiResponse> {
  let extraction;
  try {
    extraction = await extractSpot(text);
  } catch (err) {
    console.error("[api/solve] extraction failed:", err instanceof Error ? err.message : err);
    return cantSolve(err instanceof LlmUnavailableError ? "LLM_UNAVAILABLE" : "INTERNAL");
  }

  const prepared = prepareSolve(extraction);
  if (!prepared.ok) return prepared.error;

  const result = await callSolver(prepared.request, { onStatus, signal });
  if (result.status !== "ok") return result satisfies CantSolveResponse;

  return presentResult(result, prepared.spot, prepared.assumptions, extraction.notes, prepared.request.starting_pot);
}

function streamSolve(text: string, req: Request): Response {
  // Browser gone -> abort the solver request, which frees its queue slot.
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Stream already closed or cancelled.
        }
      };
      send(PADDING);
      const result = await solveText(text, (event) => send(ndjsonLine(event)), abort.signal);
      send(finalLine(result));
      try {
        controller.close();
      } catch {
        // Already cancelled.
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
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

  // Rate limit before spending an LLM call. Fails closed if the solver is down.
  const refused = await admitSolve(clientIp(req.headers));
  if (refused) return reply(refused);

  if (wantsNdjson(req.headers)) return streamSolve(text.trim(), req);
  return reply(await solveText(text.trim()));
}
