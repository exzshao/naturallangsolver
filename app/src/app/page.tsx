"use client";

import { CantSolve, Divider, SolveResult } from "@/components/results";
import { ThemeToggle } from "@/components/theme-toggle";
import type { SolveApiResponse } from "@/lib/present";
import { cantSolve } from "@/lib/validate";
import { useEffect, useRef, useState } from "react";

const EXAMPLES = [
  "BTN vs BB single raised pot, 100bb deep, flop Td9d6h, I'm on the button with AhKh, BB checks to me.",
  "River spot: BTN vs BB single raised pot, board Td9d6hQc2s, I'm in the BB with KhQh.",
  "3-bet pot, I'm on the button vs the BB, turn Ks7d2c5h, 20bb pot and 90bb behind. I have QhQd.",
];

type State =
  | { kind: "idle" }
  | { kind: "loading"; input: string; startedAt: number }
  | { kind: "done"; input: string; result: SolveApiResponse };

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
}

function Loading({ since }: { since: number }) {
  return (
    <div role="status" className="inv -mx-3 px-3 py-[1.6em]">
      <p>
        SOLVING... <Elapsed since={since} />
        <span aria-hidden className="cursor-blink">
          _
        </span>
      </p>
      <p className="text-mute">RIVER: ~1s. FLOP: UP TO ~90s.</p>
    </div>
  );
}

export default function Home() {
  const [text, setText] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const resultRef = useRef<HTMLDivElement>(null);
  const loading = state.kind === "loading";

  async function solve(input: string) {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setState({ kind: "loading", input: trimmed, startedAt: Date.now() });
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    let result: SolveApiResponse;
    try {
      const res = await fetch("/api/solve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      result = (await res.json()) as SolveApiResponse;
    } catch {
      result = cantSolve("INTERNAL", "Can't solve this: couldn't reach the server.");
    }
    setState({ kind: "done", input: trimmed, result });
  }

  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto w-full max-w-[640px] flex-1 px-5 pt-[4.8em]">
        <header className="mb-[2em]">
          <div className="flex items-baseline justify-between gap-[2ch]">
            <h1>
              <span className="inv px-[1ch]">NLP SOLVER</span>
            </h1>
            <ThemeToggle />
          </div>
          <p className="mt-[1.6em] text-mute uppercase">
            Describe a heads-up postflop spot. A GTO solver returns the strategy. Missing details get defaults, listed
            as assumptions.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            solve(text);
          }}
        >
          <label htmlFor="spot" className="mb-[0.8em] block uppercase">
            Spot
          </label>
          <textarea
            id="spot"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) solve(text);
            }}
            rows={6}
            maxLength={2000}
            placeholder="BTN vs BB single raised pot, flop Td9d6h, I have AhKh on the button"
            className="block w-full resize-y border border-mute bg-transparent p-[1ch] outline-none placeholder:text-mute focus:border-ink"
          />
          <div className="mt-[0.8em] flex items-center justify-between gap-[2ch]">
            <span className="hidden text-mute uppercase sm:inline">⌘/Ctrl+Enter</span>
            <button type="submit" disabled={loading || !text.trim()} className="btn ml-auto uppercase">
              {loading ? "[Solving...]" : "[Solve]"}
            </button>
          </div>
        </form>

        <div className="mt-[1.6em]">
          <p className="mb-[0.8em] uppercase">Examples</p>
          <ul>
            {EXAMPLES.map((ex) => (
              <li key={ex} className="mb-[0.8em]">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setText(ex);
                    solve(ex);
                  }}
                  className="btn"
                >
                  [{ex}]
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div ref={resultRef} className="scroll-mt-[1.6em]" aria-live="polite">
          {state.kind !== "idle" && <Divider />}
          {state.kind === "loading" && <Loading since={state.startedAt} />}
          {state.kind === "done" &&
            (state.result.status === "ok" ? (
              <SolveResult r={state.result} />
            ) : (
              <CantSolve r={state.result} input={state.input} />
            ))}
        </div>
      </main>

      <footer className="mx-auto w-full max-w-[640px] px-5 pb-[4.8em] text-mute uppercase">
        <Divider />
        Solver:{" "}
        <a className="btn" href="https://github.com/b-inary/postflop-solver">
          [postflop-solver]
        </a>{" "}
        (AGPL-3.0).{" "}
        <a className="btn" href="https://github.com/exzshao/naturallangsolver">
          [Source]
        </a>
        . The language model only reads the spot. It never makes up strategy.
      </footer>
    </div>
  );
}
