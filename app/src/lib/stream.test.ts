import { describe, expect, it } from "vitest";
import { applyLine, finalLine, INITIAL_STREAM, parseLine, readLines, type StreamState } from "./stream";
import { CANT_SOLVE_MESSAGES } from "./validate";

const run = (lines: string[], from: StreamState = INITIAL_STREAM) => lines.reduce(applyLine, from);

function bytes(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe("parseLine", () => {
  it("reads status lines and strips type from final lines", () => {
    expect(parseLine('{"type":"queued","position":3}')).toEqual({ kind: "status", event: { type: "queued", position: 3 } });
    expect(parseLine('{"type":"solving"}')).toEqual({ kind: "status", event: { type: "solving" } });
    expect(parseLine('{"type":"error","status":"cant_solve","reason":"TIMEOUT","message":"m"}')).toEqual({
      kind: "final",
      body: { status: "cant_solve", reason: "TIMEOUT", message: "m" },
    });
  });

  it.each(["", "   ", "not json", "42", "null", '{"type":"queued","position":0}', '{"type":"queued"}', '{"type":"other"}', '{"type":"result"}'])(
    "skips %j",
    (line) => {
      expect(parseLine(line)).toBeNull();
    },
  );
});

describe("applyLine (UI progress)", () => {
  it("moves working -> queued #3 -> #2 -> #1 -> solving -> result", () => {
    const seen: string[] = [];
    let s = INITIAL_STREAM;
    for (const line of [
      " ".repeat(1024),
      '{"type":"queued","position":3}',
      '{"type":"queued","position":2}',
      '{"type":"queued","position":1}',
      '{"type":"solving"}',
    ]) {
      s = applyLine(s, line);
      seen.push(s.progress.phase === "queued" ? `#${s.progress.position}` : s.progress.phase);
    }
    expect(seen).toEqual(["working", "#3", "#2", "#1", "solving"]);
    expect(s.result).toBeNull();

    const done = applyLine(s, '{"type":"result","status":"ok","nodes":[],"stats":{}}');
    expect(done.result).toMatchObject({ status: "ok", nodes: [] });
    expect(done.result).not.toHaveProperty("type");
  });

  it("returns the same object for heartbeats and junk, and ignores lines after the result", () => {
    const queued = run(['{"type":"queued","position":2}']);
    expect(applyLine(queued, '{"type":"queued","position":2}')).toBe(queued);
    expect(applyLine(queued, "garbage")).toBe(queued);
    const solving = applyLine(queued, '{"type":"solving"}');
    expect(applyLine(solving, '{"type":"solving"}')).toBe(solving);

    const done = applyLine(solving, '{"type":"error","status":"cant_solve","reason":"SOLVER_BUSY","message":"x"}');
    expect(done.result).toEqual({ status: "cant_solve", reason: "SOLVER_BUSY", message: "x" });
    expect(applyLine(done, '{"type":"queued","position":1}')).toBe(done);
  });

  it("turns a malformed final line into INTERNAL", () => {
    const s = run(['{"type":"error","status":"cant_solve","reason":"NOPE","message":"x"}']);
    expect(s.result).toEqual({ status: "cant_solve", reason: "INTERNAL", message: CANT_SOLVE_MESSAGES.INTERNAL });
  });

  it("round-trips finalLine", () => {
    const body = { status: "cant_solve", reason: "TIMEOUT", message: "m" } as const;
    expect(finalLine(body).endsWith("\n")).toBe(true);
    expect(run([finalLine(body).trim()]).result).toEqual(body);
  });
});

describe("readLines", () => {
  it("splits across chunk boundaries and keeps an unterminated last line", async () => {
    const out: string[] = [];
    for await (const l of readLines(bytes(['{"type":"que', 'ued","position":1}\n{"type":"sol', 'ving"}\n', "tail"]))) {
      out.push(l);
    }
    expect(out).toEqual(['{"type":"queued","position":1}', '{"type":"solving"}', "tail"]);
  });
});
