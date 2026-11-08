import { fmtLineShare } from "@/lib/line";
import { describeStreetSizes, type SolveOkPayload } from "@/lib/present";
import type { CantSolveResponse } from "@/lib/types";
import { Fragment, type ReactNode } from "react";
import { CardRow, HandText } from "./cards";
import { ActionBreakdown, pct, upper } from "./strategy";

const POT_TYPE_LABEL: Record<SolveOkPayload["spot"]["potType"], string> = {
  srp: "Single raised pot",
  "3bet": "3-bet pot",
  "4bet": "4-bet pot",
  limped: "Limped pot",
};

const STREET_ORDER = ["flop", "turn", "river"] as const;

const fmtBb = (n: number) => `${Math.round(n * 100) / 100}bb`;

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** A line of dashes, clipped to the column. */
export function Divider() {
  return (
    <div aria-hidden className="my-[1.2em] overflow-hidden whitespace-nowrap text-mute select-none">
      {"-".repeat(120)}
    </div>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section>
      {title && <h2 className="mb-[1.6em] uppercase">{title}</h2>}
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-mute uppercase">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function SpotCard({ r }: { r: SolveOkPayload }) {
  const s = r.spot;
  const seat = (p: string) => (p === s.oopPosition ? "OOP" : "IP");
  const sizes = STREET_ORDER.slice(STREET_ORDER.indexOf(s.street));
  return (
    <Section title="Spot">
      <dl className="grid grid-cols-[11ch_1fr] gap-x-[1ch]">
        <Fact label={s.street}>
          <CardRow cards={s.board} />
        </Fact>
        {s.heroHand && (
          <Fact label="Your hand">
            <CardRow cards={s.heroHand} />
          </Fact>
        )}
        {r.villainHand && (
          <Fact label="Villain has">
            {/^([2-9TJQKA][cdhs]){2}$/.test(r.villainHand) ? <CardRow cards={r.villainHand} /> : r.villainHand}
          </Fact>
        )}
        <Fact label="Hero">
          {s.heroPosition} <span className="text-mute">{seat(s.heroPosition)}</span>
        </Fact>
        <Fact label="Villain">
          {s.villainPosition} <span className="text-mute">{seat(s.villainPosition)}</span>
        </Fact>
        <Fact label="Pot">{fmtBb(s.potBb)}</Fact>
        <Fact label="Stack">{fmtBb(s.effectiveStackBb)}</Fact>
        <Fact label="Pot type">
          <span className="uppercase">{POT_TYPE_LABEL[s.potType]}</span>
        </Fact>
        <Fact label="Sizes">
          {sizes.map((st) => (
            <span key={st} className="block">
              <span className="text-mute uppercase">{st}</span>{" "}
              {describeStreetSizes(
                s.betSizes[st],
                s.oopPosition,
                s.ipPosition,
                (s.addedSizes ?? []).filter((a) => a.street === st),
              )}
            </span>
          ))}
        </Fact>
      </dl>
      <details className="group mt-[1.6em]">
        <summary className="btn inline-block list-none uppercase [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">[+] Ranges</span>
          <span className="hidden group-open:inline">[-] Ranges</span>
          {r.narrowing && <span> (narrowed)</span>}
        </summary>
        <div className="mt-[0.8em]">
          {r.narrowing ? (
            <NarrowedRanges n={r.narrowing} preflop={{ oop: s.oopRange, ip: s.ipRange }} />
          ) : (
            (
              [
                [`OOP ${s.oopPosition}`, s.oopRange],
                [`IP ${s.ipPosition}`, s.ipRange],
              ] as const
            ).map(([label, range]) => (
              <div key={label} className="mt-[0.8em]">
                <div className="text-mute">{label}</div>
                <code className="block break-all">{range}</code>
              </div>
            ))
          )}
        </div>
      </details>
    </Section>
  );
}

/** Classes shown before "+N MORE". */
const NARROWED_CLASSES = 18;

const fmtCombos = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** Narrowed ranges: combo counts, the biggest classes with their weight, exact strings on demand. */
function NarrowedRanges({ n, preflop }: { n: NonNullable<SolveOkPayload["narrowing"]>; preflop: Record<"oop" | "ip", string> }) {
  return (
    <>
      <p className="text-mute uppercase">
        Narrowed by a flop solve of your line. Weight = share of each hand class still in the range.
      </p>
      {(["oop", "ip"] as const).map((p) => {
        const pl = n.players[p];
        const extra = pl.classes.length - NARROWED_CLASSES;
        return (
          <div key={p} className="mt-[1.2em]">
            <div className="uppercase">
              {p} {pl.position}{" "}
              <span className="text-mute tabular-nums">
                {fmtCombos(pl.combosAfter)} of {fmtCombos(pl.combosBefore)} combos
              </span>
            </div>
            {pl.blended && (
              <p className="text-mute uppercase">
                Unusual line ({fmtLineShare(pl.lineProbability ?? 0)} of range): rough estimate, blended toward the starting
                range
              </p>
            )}
            <div className="flex flex-wrap gap-x-[2ch]">
              {pl.classes.slice(0, NARROWED_CLASSES).map((c) => (
                <span key={c.hand} className="whitespace-nowrap">
                  {c.hand} <span className="tabular-nums text-mute">{pct(c.weight)}</span>
                </span>
              ))}
              {extra > 0 && <span className="text-mute uppercase">+{extra} more</span>}
            </div>
            <details className="group/x mt-[0.4em]">
              <summary className="btn inline-block list-none text-mute uppercase [&::-webkit-details-marker]:hidden">
                <span className="group-open/x:hidden">[+] Exact weights</span>
                <span className="hidden group-open/x:inline">[-] Exact weights</span>
              </summary>
              <code className="block break-all">{pl.range}</code>
              <div className="mt-[0.4em] text-mute uppercase">Preflop range</div>
              <code className="block break-all text-mute">{preflop[p]}</code>
            </details>
          </div>
        );
      })}
    </>
  );
}

function Assumptions({ items, notes, atDecision }: { items: string[]; notes: string | null; atDecision: boolean }) {
  if (items.length === 0 && !notes) return null;
  return (
    <Section title={items.length > 0 ? `Assumptions (${items.length})` : "Noted"}>
      {items.length > 0 && (
        <>
          <p className="mb-[0.8em] text-mute uppercase">Not stated. Defaults used:</p>
          <ul>
            {items.map((a) => (
              <li key={a} className="flex gap-[1ch]">
                <span aria-hidden className="text-mute">
                  -
                </span>
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {notes && (
        <p className={items.length > 0 ? "mt-[1.6em]" : ""}>
          {items.length > 0 && <span className="uppercase">Noted: </span>}
          {notes}{" "}
          {!atDecision && <span className="text-mute uppercase">Strategy starts at the beginning of the street.</span>}
        </p>
      )}
    </Section>
  );
}

function HeroHand({ h }: { h: NonNullable<SolveOkPayload["heroHand"]> }) {
  return (
    <section className="inv -mx-3 px-3 py-[1.6em]">
      <h2 className="uppercase">
        Your hand <HandText hand={h.hand} /> — {upper(h.decision)}
      </h2>
      {h.streetAction && <p className="text-mute">{upper(h.streetAction)}</p>}
      <p className="mt-[0.8em] mb-[1.6em] flex flex-wrap gap-x-[3ch]">
        <span>
          <span className="text-mute">EQUITY</span> <span className="tabular-nums">{pct(h.equity)}</span>
        </span>
        <span>
          <span className="text-mute">EV</span> <span className="tabular-nums">{fmtBb(h.evBb)}</span>
        </span>
      </p>
      <ActionBreakdown actions={h.actions} showHands={false} />
    </section>
  );
}

/** Villain's range where hero decides, after the current-street action. */
function VillainRangeHere({ v }: { v: NonNullable<NonNullable<SolveOkPayload["streetLine"]>["villainRange"]> }) {
  const extra = v.classes.length - NARROWED_CLASSES;
  return (
    <Section title="Villain range at your decision">
      <p className="mb-[0.8em] text-mute uppercase">
        {v.position}{" "}
        <span className="tabular-nums">
          {fmtCombos(v.combosAfter)} of {fmtCombos(v.combosBefore)} combos
        </span>
        . Weight = share of each hand class still in the range.
      </p>
      <div className="flex flex-wrap gap-x-[2ch]">
        {v.classes.slice(0, NARROWED_CLASSES).map((c) => (
          <span key={c.hand} className="whitespace-nowrap">
            {c.hand} <span className="tabular-nums text-mute">{pct(c.weight)}</span>
          </span>
        ))}
        {extra > 0 && <span className="text-mute uppercase">+{extra} more</span>}
      </div>
    </Section>
  );
}

function Players({ r }: { r: SolveOkPayload }) {
  return (
    <Section title={r.streetLine?.matched ? "Range equity / EV at your decision" : "Range equity / EV"}>
      <div className="grid grid-cols-[auto_auto_1fr] gap-x-[2ch]">
        {(["oop", "ip"] as const).map((p) => {
          const pl = r.players[p];
          const hero = r.spot.heroPlayer === p;
          return (
            <Fragment key={p}>
              <span className="whitespace-nowrap">
                {pl.position} <span className="text-mute">{p.toUpperCase()}</span>
              </span>
              <span>{hero ? <span className="inv px-[0.5ch]">YOU</span> : null}</span>
              <span className="flex flex-wrap justify-end gap-x-[2ch] tabular-nums">
                <span>
                  <span className="text-mute">EQ</span> {pct(pl.equity)}
                </span>
                <span>
                  <span className="text-mute">EV</span> {fmtBb(pl.evBb)}
                </span>
              </span>
            </Fragment>
          );
        })}
      </div>
    </Section>
  );
}

export function SolveResult({ r }: { r: SolveOkPayload }) {
  const st = r.stats;
  const aboveTarget = st.exploitabilityPct > st.targetExploitabilityPct;
  const hasAssumptions = r.assumptions.length > 0 || !!r.notes;
  return (
    <div>
      <SpotCard r={r} />
      {hasAssumptions && (
        <>
          <Divider />
          <Assumptions items={r.assumptions} notes={r.notes} atDecision={!!r.streetLine?.matched} />
        </>
      )}
      {r.heroHand && (
        <>
          <Divider />
          <HeroHand h={r.heroHand} />
        </>
      )}
      {r.nodes.map((n, i) => (
        <Fragment key={i}>
          <Divider />
          <Section>
            <h2 className="uppercase">{n.isHero ? "Your range" : "Villain range"}</h2>
            <p className="text-mute">{upper(n.title)}</p>
            <p className="mb-[1.6em] text-mute uppercase">Average of every hand {n.position} can hold here.</p>
            <ActionBreakdown actions={n.actions} />
          </Section>
        </Fragment>
      ))}
      {r.streetLine?.villainRange && (
        <>
          <Divider />
          <VillainRangeHere v={r.streetLine.villainRange} />
        </>
      )}
      <Divider />
      <Players r={r} />
      <Divider />
      <p className="text-mute">
        <span className={aboveTarget ? "text-ink" : ""}>
          EXPLOITABILITY {st.exploitabilityPct.toFixed(2)}% OF POT
          {aboveTarget ? ` (ABOVE ${st.targetExploitabilityPct}% TARGET)` : ""}
        </span>
        {" · "}
        {st.iterations} ITERATIONS · {fmtMs(st.solveMs)}
        {r.narrowing ? ` (FLOP SOLVE ${fmtMs(r.narrowing.flopSolveMs)})` : ""} ·{" "}
        {st.memoryMb < 1 ? "<1" : Math.round(st.memoryMb)}MB
        {st.compressed ? " (COMPRESSED)" : ""}
      </p>
    </div>
  );
}

export function CantSolve({ r, input }: { r: CantSolveResponse; input: string }) {
  const stripped = r.message.replace(/^Can't solve this:\s*/i, "");
  const reason = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return (
    <section>
      <h2>
        <span className="inv px-[1ch]">CAN&apos;T SOLVE THIS</span>
      </h2>
      <p className="mt-[1.6em]">{reason}</p>
      <p className="text-mute">REASON: {r.reason}</p>
      <figure className="mt-[1.6em]">
        <figcaption className="text-mute uppercase">You wrote</figcaption>
        <blockquote className="flex gap-[1ch] break-words whitespace-pre-wrap">
          <span aria-hidden className="text-mute">
            &gt;
          </span>
          <span className="min-w-0">{input}</span>
        </blockquote>
      </figure>
    </section>
  );
}
