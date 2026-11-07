// Card rendering with a four-color deck (spades dark, hearts red, diamonds
// blue, clubs green) so suits are readable at a glance.

const SUIT_SYMBOL: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

const SUIT_COLOR: Record<string, string> = {
  s: "text-zinc-900 dark:text-zinc-100",
  h: "text-red-600 dark:text-red-400",
  d: "text-blue-600 dark:text-blue-400",
  c: "text-emerald-700 dark:text-emerald-400",
};

function splitCards(cards: string): string[] {
  return cards.match(/.{2}/g) ?? [];
}

const rankLabel = (r: string) => (r === "T" ? "10" : r);

export function PlayingCard({ card, size = "md" }: { card: string; size?: "sm" | "md" }) {
  const [rank, suit] = [card[0], card[1]];
  const dims = size === "md" ? "h-14 w-10 text-lg sm:h-16 sm:w-12 sm:text-xl" : "h-9 w-7 text-sm";
  return (
    <span
      className={`inline-flex flex-col items-center justify-center rounded-md border border-zinc-300 bg-white font-semibold leading-none shadow-sm dark:border-zinc-600 dark:bg-zinc-800 ${dims} ${SUIT_COLOR[suit]}`}
      aria-label={`${rankLabel(rank)} of ${{ s: "spades", h: "hearts", d: "diamonds", c: "clubs" }[suit]}`}
    >
      <span>{rankLabel(rank)}</span>
      <span className={size === "md" ? "text-base sm:text-lg" : "text-xs"}>{SUIT_SYMBOL[suit]}</span>
    </span>
  );
}

export function CardRow({ cards, size = "md" }: { cards: string; size?: "sm" | "md" }) {
  return (
    <span className="inline-flex gap-1.5">
      {splitCards(cards).map((c) => (
        <PlayingCard key={c} card={c} size={size} />
      ))}
    </span>
  );
}

/** Inline hand text like "Q♥J♥", for dense lists. */
export function HandText({ hand }: { hand: string }) {
  return (
    <span className="whitespace-nowrap font-mono">
      {splitCards(hand).map((c, i) => (
        <span key={i} className={SUIT_COLOR[c[1]]}>
          {c[0]}
          {SUIT_SYMBOL[c[1]]}
        </span>
      ))}
    </span>
  );
}
