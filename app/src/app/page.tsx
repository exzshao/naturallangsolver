"use client";

import { CantSolve, SolveResult } from "@/components/results";
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
    <div
      role="status"
      className="flex items-center gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <span className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-zinc-300 border-t-emerald-600 dark:border-zinc-700 dark:border-t-emerald-400" />
      <div className="text-sm">
        <p className="font-medium">
          Reading your spot and solving… <Elapsed since={since} />
        </p>
        <p className="text-zinc-500 dark:text-zinc-400">River spots take a second. Flops can take up to ~90s.</p>
      </div>
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
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-zinc-950">
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Poker spot solver</h1>
          <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            Describe a heads-up postflop spot in plain English. A GTO solver works out the strategy; anything you leave
            out gets a default, listed as an assumption.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            solve(text);
          }}
          className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm focus-within:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-zinc-600"
        >
          <label htmlFor="spot" className="sr-only">
            Describe the spot
          </label>
          <textarea
            id="spot"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) solve(text);
            }}
            rows={3}
            maxLength={2000}
            placeholder="e.g. BTN vs BB single raised pot, flop Td9d6h, I have AhKh on the button…"
            className="block w-full resize-y bg-transparent px-1 text-base outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="hidden text-xs text-zinc-400 sm:inline dark:text-zinc-500">⌘/Ctrl + Enter to solve</span>
            <button
              type="submit"
              disabled={loading || !text.trim()}
              className="ml-auto rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {loading ? "Solving…" : "Solve"}
            </button>
          </div>
        </form>

        <div className="mt-3">
          <p className="mb-1.5 text-xs text-zinc-500 dark:text-zinc-400">Try an example:</p>
          <div className="flex flex-col gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                disabled={loading}
                onClick={() => {
                  setText(ex);
                  solve(ex);
                }}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm text-zinc-700 transition hover:border-zinc-400 hover:text-zinc-950 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-zinc-50"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        <div ref={resultRef} className="mt-6 scroll-mt-4" aria-live="polite">
          {state.kind === "loading" && <Loading since={state.startedAt} />}
          {state.kind === "done" &&
            (state.result.status === "ok" ? (
              <SolveResult r={state.result} />
            ) : (
              <CantSolve r={state.result} input={state.input} />
            ))}
        </div>
      </main>

      <footer className="mx-auto w-full max-w-2xl px-4 pb-8 text-xs text-zinc-500 dark:text-zinc-400">
        Solves with{" "}
        <a className="underline hover:text-zinc-800 dark:hover:text-zinc-200" href="https://github.com/b-inary/postflop-solver">
          postflop-solver
        </a>{" "}
        (AGPL-3.0).{" "}
        <a className="underline hover:text-zinc-800 dark:hover:text-zinc-200" href="https://github.com/exzshao/naturallangsolver">
          Source code
        </a>
        . The language model only extracts the spot; it never invents strategy.
      </footer>
    </div>
  );
}
