import type { DisplayAction } from "@/lib/present";

// Check/call green, bets warm and darker as they get bigger, all-in deepest.
const BET_COLORS = ["bg-amber-400", "bg-orange-500", "bg-red-500", "bg-rose-600"];

export function actionColors(actions: DisplayAction[]): string[] {
  let bet = 0;
  return actions.map((a) => {
    if (a.action === "Check" || a.action === "Call") return "bg-emerald-500";
    if (a.action === "Fold") return "bg-sky-500";
    if (a.action === "AllIn") return "bg-rose-900 dark:bg-rose-800";
    return BET_COLORS[Math.min(bet++, BET_COLORS.length - 1)];
  });
}

export const pct = (f: number) => `${Math.round(f * 100)}%`;

/** Like pct, but never rounds a nonzero frequency down to "0%". */
const classPct = (f: number) => (f > 0 && f < 0.005 ? "<1%" : pct(f));

function sizeNote(a: DisplayAction): string | null {
  return a.potPct === null ? null : `${a.potPct}% pot`;
}

export function StackedBar({ actions, colors }: { actions: DisplayAction[]; colors: string[] }) {
  return (
    <div
      className="flex h-7 w-full overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800"
      role="img"
      aria-label={actions.map((a) => `${a.label} ${pct(a.frequency)}`).join(", ")}
    >
      {actions.map((a, i) =>
        a.frequency > 0.005 ? (
          <div
            key={i}
            className={`${colors[i]} flex items-center justify-center text-xs font-semibold text-white/95`}
            style={{ width: `${a.frequency * 100}%` }}
            title={`${a.label}: ${pct(a.frequency)}`}
          >
            {a.frequency >= 0.12 ? pct(a.frequency) : null}
          </div>
        ) : null,
      )}
    </div>
  );
}

/** Bar plus one row per action: label, size as % of pot, frequency, top hand classes. */
export function ActionBreakdown({ actions, showHands = true }: { actions: DisplayAction[]; showHands?: boolean }) {
  const colors = actionColors(actions);
  return (
    <div className="space-y-3">
      <StackedBar actions={actions} colors={colors} />
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {actions.map((a, i) => {
          const muted = a.frequency < 0.005;
          return (
            <li key={i} className={`py-2 text-sm ${muted ? "opacity-45" : ""}`}>
              <div className="flex items-baseline gap-2">
                <span className={`mt-0.5 inline-block h-2.5 w-2.5 shrink-0 self-center rounded-sm ${colors[i]}`} />
                <span className="font-medium">{a.label}</span>
                {sizeNote(a) && <span className="text-zinc-500 dark:text-zinc-400">{sizeNote(a)}</span>}
                <span className="ml-auto font-semibold tabular-nums">{pct(a.frequency)}</span>
              </div>
              {showHands && a.topClasses.length > 0 && !muted && (
                <div
                  className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-[18px] text-xs"
                  aria-label={`Hands that ${a.label.toLowerCase()} most`}
                >
                  {a.topClasses.map((h) => (
                    <span key={h.hand} className="whitespace-nowrap">
                      <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">{h.hand}</span>{" "}
                      <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{classPct(h.frequency)}</span>
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
