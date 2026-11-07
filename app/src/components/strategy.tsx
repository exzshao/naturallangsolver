import type { DisplayAction } from "@/lib/present";

// Grayscale fills (see globals.css). Fold is an empty outline, check/call light
// gray, bets get denser as they grow, all-in solid ink.
const BET_FILLS = ["fill-mute", "fill-hatch", "fill-cross"];

export function actionColors(actions: DisplayAction[]): string[] {
  let bet = 0;
  return actions.map((a) => {
    if (a.action === "Check" || a.action === "Call") return "fill-faint";
    if (a.action === "Fold") return "fill-outline";
    if (a.action === "AllIn") return "fill-ink";
    return BET_FILLS[Math.min(bet++, BET_FILLS.length - 1)];
  });
}

export const pct = (f: number) => `${Math.round(f * 100)}%`;

/** Uppercase a data label but keep "bb" (big blinds) lowercase so it can't read as the BB seat. */
export const upper = (s: string) => s.replace(/[A-Za-z-]+/g, (w) => (w === "bb" ? w : w.toUpperCase()));

/** Like pct, but never rounds a nonzero frequency down to "0%". */
const classPct = (f: number) => (f > 0 && f < 0.005 ? "<1%" : pct(f));

function sizeNote(a: DisplayAction): string | null {
  return a.potPct === null ? null : `${a.potPct}% POT`;
}

export function StackedBar({ actions, colors }: { actions: DisplayAction[]; colors: string[] }) {
  return (
    <div
      className="flex h-[1.6em] w-full overflow-hidden"
      role="img"
      aria-label={actions.map((a) => `${a.label} ${pct(a.frequency)}`).join(", ")}
    >
      {actions.map((a, i) =>
        a.frequency > 0.005 ? (
          <div
            key={i}
            className={`${colors[i]} flex items-center justify-center overflow-hidden`}
            style={{ width: `${a.frequency * 100}%` }}
            title={`${a.label}: ${pct(a.frequency)}`}
          >
            {a.frequency >= 0.12 ? <span className="bg-inherit px-[0.5ch]">{pct(a.frequency)}</span> : null}
          </div>
        ) : null,
      )}
    </div>
  );
}

function Swatch({ fill }: { fill: string }) {
  return <span aria-hidden className={`${fill} inline-block h-[1em] w-[2ch] shrink-0 self-center`} />;
}

/** Bar plus one row per action: swatch, label, size as % of pot, frequency, top hand classes. */
export function ActionBreakdown({ actions, showHands = true }: { actions: DisplayAction[]; showHands?: boolean }) {
  const colors = actionColors(actions);
  return (
    <div>
      <StackedBar actions={actions} colors={colors} />
      <ul className="mt-[1.6em]">
        {actions.map((a, i) => {
          const muted = a.frequency < 0.005;
          return (
            <li key={i} className={muted ? "text-mute" : ""}>
              <div className="flex items-baseline gap-[1ch]">
                <Swatch fill={colors[i]} />
                <span>{upper(a.label)}</span>
                {sizeNote(a) && <span className="text-mute">{sizeNote(a)}</span>}
                <span className="ml-auto tabular-nums">{pct(a.frequency)}</span>
              </div>
              {showHands && a.topClasses.length > 0 && !muted && (
                <div
                  className="mb-[0.8em] flex flex-wrap gap-x-[2ch] pl-[3ch]"
                  aria-label={`Hands that ${a.label.toLowerCase()} most`}
                >
                  {a.topClasses.map((h) => (
                    <span key={h.hand} className="whitespace-nowrap">
                      {h.hand} <span className="tabular-nums text-mute">{classPct(h.frequency)}</span>
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
