// NDJSON streaming protocol shared by the solver, /api/solve, and the UI
// (SPEC §7). Pure helpers: line splitting, parsing, and progress state.
//
// A stream is zero or more status lines, then exactly one final line:
//   {"type":"queued","position":3}   place in the solver queue (1 = next); repeats as a heartbeat
//   {"type":"solving"}               the solve is running; repeats as a heartbeat
//   {"type":"result", ...ok body}    final, success
//   {"type":"error", ...§6 body}     final, can't solve
import type { SolveApiResponse } from "./present";
import type { CantSolveReason } from "./types";
import { CANT_SOLVE_REASONS } from "./types";
import { cantSolve } from "./validate";

export const NDJSON = "application/x-ndjson";

export type StatusEvent = { type: "queued"; position: number } | { type: "solving" };

/** Progress shown while waiting. "working" = before the solver reports anything (LLM, cold start). */
export type Progress = { phase: "working" } | { phase: "queued"; position: number } | { phase: "solving" };

export type StreamLine =
  | { kind: "status"; event: StatusEvent }
  | { kind: "final"; body: Record<string, unknown> & { status: string } };

export function ndjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function isNdjson(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().includes(NDJSON);
}

/**
 * Parses one line. Status lines become events; `result`/`error` lines become
 * the final body with `type` stripped. Blank, malformed, or unknown lines
 * return null so callers can skip them.
 */
export function parseLine(line: string): StreamLine | null {
  if (!line.trim()) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const { type, ...rest } = v as Record<string, unknown>;
  if (type === "queued") {
    const position = rest.position;
    if (typeof position !== "number" || !Number.isInteger(position) || position < 1) return null;
    return { kind: "status", event: { type: "queued", position } };
  }
  if (type === "solving") return { kind: "status", event: { type: "solving" } };
  if ((type === "result" || type === "error") && typeof rest.status === "string") {
    return { kind: "final", body: rest as Record<string, unknown> & { status: string } };
  }
  return null;
}

export function progressFor(event: StatusEvent): Progress {
  return event.type === "queued" ? { phase: "queued", position: event.position } : { phase: "solving" };
}

function isReason(x: unknown): x is CantSolveReason {
  return typeof x === "string" && (CANT_SOLVE_REASONS as readonly string[]).includes(x);
}

/** Final line from /api/solve as the payload the UI renders, or null if it isn't one. */
export function toApiResponse(body: Record<string, unknown>): SolveApiResponse | null {
  if (body.status === "ok" && Array.isArray(body.nodes)) return body as unknown as SolveApiResponse;
  if (body.status === "cant_solve" && isReason(body.reason) && typeof body.message === "string") {
    return { status: "cant_solve", reason: body.reason, message: body.message };
  }
  return null;
}

/** What the UI tracks while reading /api/solve's stream. */
export type StreamState = { progress: Progress; result: SolveApiResponse | null };

export const INITIAL_STREAM: StreamState = { progress: { phase: "working" }, result: null };

function sameProgress(a: Progress, b: Progress): boolean {
  return a.phase === b.phase && (a.phase !== "queued" || (b.phase === "queued" && a.position === b.position));
}

/**
 * Applies one NDJSON line. Returns the same object when nothing changed
 * (heartbeats, blank or unknown lines, anything after the final line), so
 * React can skip re-rendering.
 */
export function applyLine(state: StreamState, line: string): StreamState {
  if (state.result) return state;
  const parsed = parseLine(line);
  if (!parsed) return state;
  if (parsed.kind === "status") {
    const progress = progressFor(parsed.event);
    return sameProgress(state.progress, progress) ? state : { ...state, progress };
  }
  return { ...state, result: toApiResponse(parsed.body) ?? cantSolve("INTERNAL") };
}

/** Final payload as an NDJSON line: {"type":"result"|"error", ...body}. */
export function finalLine(body: SolveApiResponse): string {
  return ndjsonLine({ type: body.status === "ok" ? "result" : "error", ...body });
}

/** Splits a byte stream into lines (without the trailing newline). Emits a final unterminated line too. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, i);
        buf = buf.slice(i + 1);
      }
    }
    buf += decoder.decode();
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}
