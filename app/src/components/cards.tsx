// Cards as plain text. Suits keep a four-color deck (spades ink, hearts red,
// diamonds blue, clubs green) so they read at a glance; nothing else has color.

const SUIT_SYMBOL: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

const SUIT_COLOR: Record<string, string> = {
  s: "text-ink",
  h: "text-suit-h",
  d: "text-suit-d",
  c: "text-suit-c",
};

const SUIT_NAME: Record<string, string> = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };

function splitCards(cards: string): string[] {
  return cards.match(/.{2}/g) ?? [];
}

const rankLabel = (r: string) => (r === "T" ? "10" : r);

export function PlayingCard({ card }: { card: string; size?: "sm" | "md" }) {
  const [rank, suit] = [card[0], card[1]];
  return (
    <span className={`whitespace-nowrap ${SUIT_COLOR[suit]}`} aria-label={`${rankLabel(rank)} of ${SUIT_NAME[suit]}`}>
      {rankLabel(rank)}
      {SUIT_SYMBOL[suit]}
    </span>
  );
}

export function CardRow({ cards }: { cards: string; size?: "sm" | "md" }) {
  return (
    <span className="inline-flex flex-wrap gap-x-[1ch]">
      {splitCards(cards).map((c) => (
        <PlayingCard key={c} card={c} />
      ))}
    </span>
  );
}

/** Inline hand text like "Q♥J♥", for dense lists. */
export function HandText({ hand }: { hand: string }) {
  return (
    <span className="whitespace-nowrap">
      {splitCards(hand).map((c, i) => (
        <span key={i} className={SUIT_COLOR[c[1]]}>
          {c[0]}
          {SUIT_SYMBOL[c[1]]}
        </span>
      ))}
    </span>
  );
}
