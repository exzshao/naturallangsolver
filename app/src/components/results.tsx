import type { SolveOkPayload } from "@/lib/present";
import type { CantSolveResponse } from "@/lib/types";
import type { ReactNode } from "react";
import { CardRow, HandText } from "./cards";
import { ActionBreakdown, pct } from "./strategy";

const POT_TYPE_LABEL: Record<SolveOkPayload["spot"]["potType"], string> = {
  srp: "Single raised pot",
  "3bet": "3-bet pot",
  "4bet": "4-bet pot",
  limped: "Limped pot",
};

const STREET_ORDER = ["flop", "turn", "river"] as const;

const fmtBb = (n: number) => `${Math.round(n * 100) / 100}bb`;

export function Panel({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
    >
      {title && (
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h2>
      )}
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}

function SpotCard({ r }: { r: SolveOkPayload }) {
  const s = r.spot;
  const seat = (p: string) => (p === s.oopPosition ? "OOP" : "IP");
  const sizes = STREET_ORDER.slice(STREET_ORDER.indexOf(s.street));
  return (
    <Panel title="Spot">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1.5 text-xs text-zinc-500 capitalize dark:text-zinc-400">{s.street}</div>
          <CardRow cards={s.board} />
        </div>
        {s.heroHand && (
          <div>
            <div className="mb-1.5 text-xs text-zinc-500 dark:text-zinc-400">Your hand</div>
            <CardRow cards={s.heroHand} />
          </div>
        )}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
        <Fact label="Hero">
          {s.heroPosition} <span className="text-zinc-500 dark:text-zinc-400">({seat(s.heroPosition)})</span>
        </Fact>
        <Fact label="Villain">
          {s.villainPosition} <span className="text-zinc-500 dark:text-zinc-400">({seat(s.villainPosition)})</span>
        </Fact>
        <Fact label="Pot">{fmtBb(s.potBb)}</Fact>
        <Fact label="Effective stack">{fmtBb(s.effectiveStackBb)}</Fact>
        <Fact label="Pot type">{POT_TYPE_LABEL[s.potType]}</Fact>
        <Fact label="Bet sizes">
          <span className="block space-y-0.5 text-xs font-normal">
            {sizes.map((st) => (
              <span key={st} className="block">
                <span className="capitalize text-zinc-500 dark:text-zinc-400">{st}:</span> {s.betSizes[st].bet || "none"}
                {s.betSizes[st].raise ? `; raise ${s.betSizes[st].raise}` : "; no raises"}
              </span>
            ))}
          </span>
        </Fact>
      </dl>
      <details className="group mt-4 text-sm">
        <summary className="cursor-pointer select-none text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
          Ranges
        </summary>
        <div className="mt-2 space-y-2">
          {(
            [
              [`OOP (${s.oopPosition})`, s.oopRange],
              [`IP (${s.ipPosition})`, s.ipRange],
            ] as const
          ).map(([label, range]) => (
            <div key={label}>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
              <code className="mt-0.5 block break-words rounded bg-zinc-50 p-2 font-mono text-xs dark:bg-zinc-800/60">
                {range}
              </code>
            </div>
          ))}
        </div>
      </details>
    </Panel>
  );
}

function Assumptions({ items, notes }: { items: string[]; notes: string | null }) {
  if (items.length === 0 && !notes) return null;
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 sm:p-5 dark:border-amber-500/40 dark:bg-amber-950/30">
      {items.length > 0 && (
        <>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
            Assumptions ({items.length})
          </h2>
          <p className="mb-2 text-sm text-amber-900/80 dark:text-amber-200/80">
            You didn&apos;t say these, so the solver used defaults:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-950 marker:text-amber-500 dark:text-amber-100">
            {items.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {notes && (
        <p className={`text-sm text-amber-950 dark:text-amber-100 ${items.length > 0 ? "mt-3 border-t border-amber-200 pt-3 dark:border-amber-500/30" : ""}`}>
          <span className="font-semibold">Also noted: </span>
          {notes} <span className="text-amber-900/70 dark:text-amber-200/70">The strategy below starts from the beginning of the street.</span>
        </p>
      )}
    </section>
  );
}

function HeroHand({ h }: { h: NonNullable<SolveOkPayload["heroHand"]> }) {
  return (
    <section className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 sm:p-5 dark:border-indigo-500/30 dark:bg-indigo-950/30">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <CardRow cards={h.hand} size="sm" />
          <div>
            <h2 className="text-sm font-semibold">
              Your exact hand (<HandText hand={h.hand} />)
            </h2>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              How the solver plays this specific hand {h.situation}
            </p>
          </div>
        </div>
        <div className="flex gap-4 text-sm">
          <span>
            <span className="text-zinc-500 dark:text-zinc-400">Equity </span>
            <span className="font-semibold tabular-nums">{pct(h.equity)}</span>
          </span>
          <span>
            <span className="text-zinc-500 dark:text-zinc-400">EV </span>
            <span className="font-semibold tabular-nums">{fmtBb(h.evBb)}</span>
          </span>
        </div>
      </div>
      <ActionBreakdown actions={h.actions} showHands={false} />
    </section>
  );
}

function Players({ r }: { r: SolveOkPayload }) {
  return (
    <Panel title="Range equity and EV">
      <div className="grid grid-cols-2 gap-3">
        {(["oop", "ip"] as const).map((p) => {
          const pl = r.players[p];
          const hero = r.spot.heroPlayer === p;
          return (
            <div key={p} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60">
              <div className="text-sm font-semibold">
                {pl.position} <span className="font-normal text-zinc-500 dark:text-zinc-400">{p.toUpperCase()}</span>
                {hero && (
                  <span className="ml-1.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                    you
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span>
                  <span className="text-zinc-500 dark:text-zinc-400">Equity </span>
                  <span className="font-semibold tabular-nums">{pct(pl.equity)}</span>
                </span>
                <span>
                  <span className="text-zinc-500 dark:text-zinc-400">EV </span>
                  <span className="font-semibold tabular-nums">{fmtBb(pl.evBb)}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function SolveResult({ r }: { r: SolveOkPayload }) {
  const st = r.stats;
  const aboveTarget = st.exploitabilityPct > st.targetExploitabilityPct;
  return (
    <div className="space-y-4">
      <SpotCard r={r} />
      <Assumptions items={r.assumptions} notes={r.notes} />
      {r.heroHand && <HeroHand h={r.heroHand} />}
      {r.nodes.map((n, i) => (
        <Panel key={i}>
          <div className="mb-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="text-sm font-semibold">{n.isHero ? "Your whole range" : "Villain's whole range"}</h2>
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{n.title}</span>
            </div>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Average over every hand {n.position} could hold here
            </p>
          </div>
          <ActionBreakdown actions={n.actions} />
        </Panel>
      ))}
      <Players r={r} />
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400">
        <span className={aboveTarget ? "font-medium text-amber-700 dark:text-amber-400" : ""}>
          Exploitability {st.exploitabilityPct.toFixed(2)}% of pot
          {aboveTarget ? ` (above the ${st.targetExploitabilityPct}% target)` : ""}
        </span>
        {" · "}
        {st.iterations} iterations · {st.solveMs < 1000 ? `${st.solveMs} ms` : `${(st.solveMs / 1000).toFixed(1)}s`} ·{" "}
        {st.memoryMb < 1 ? "<1" : Math.round(st.memoryMb)} MB
        {st.compressed ? " (compressed)" : ""}
      </p>
    </div>
  );
}

export function CantSolve({ r, input }: { r: CantSolveResponse; input: string }) {
  return (
    <Panel>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-sm font-bold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
        >
          !
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{r.message}</p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{r.reason}</p>
        </div>
      </div>
      <figure className="mt-4">
        <figcaption className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">You wrote</figcaption>
        <blockquote className="break-words border-l-2 border-zinc-300 pl-3 text-sm whitespace-pre-wrap text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
          {input}
        </blockquote>
      </figure>
    </Panel>
  );
}
