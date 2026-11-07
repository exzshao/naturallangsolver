// Small poker helpers shared by defaults, validation, and the request builder:
// card parsing, OOP/IP ordering, bb<->chip conversion, and a range-membership
// check that mirrors postflop-solver's PioSOLVER-style range syntax.
import type { Position, Street } from "./schema";
import type { Player } from "./types";

// ---------- units ----------

export const CHIPS_PER_BB = 100;

export function bbToChips(bb: number): number {
  return Math.round(bb * CHIPS_PER_BB);
}

export function chipsToBb(chips: number): number {
  return chips / CHIPS_PER_BB;
}

// ---------- positions ----------

/** Postflop action order: earlier acts first, i.e. is out of position. */
export const POSTFLOP_ORDER: readonly Position[] = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];

export function orderPositions(a: Position, b: Position): { oop: Position; ip: Position } {
  return POSTFLOP_ORDER.indexOf(a) < POSTFLOP_ORDER.indexOf(b)
    ? { oop: a, ip: b }
    : { oop: b, ip: a };
}

/** Which seat `hero` is in, given the opponent's position. */
export function heroPlayer(hero: Position, villain: Position): Player {
  return orderPositions(hero, villain).oop === hero ? "oop" : "ip";
}

// ---------- cards ----------

export const STREET_BY_CARD_COUNT: Record<number, Exclude<Street, "preflop">> = {
  3: "flop",
  4: "turn",
  5: "river",
};

const RANKS = "23456789TJQKA";
const SUITS = "cdhs";

export type Card = { rank: number; suit: number };

/** Normalize and split a card string like "Td 9d 6h" or "10d9d6h" into ["Td","9d","6h"]. Null if malformed. */
export function parseCards(input: string): string[] | null {
  const s = input.replace(/[\s,]+/g, "").replace(/10/g, "T");
  if (s.length === 0 || s.length % 2 !== 0) return null;
  const cards: string[] = [];
  for (let i = 0; i < s.length; i += 2) {
    const rank = s[i].toUpperCase();
    const suit = s[i + 1].toLowerCase();
    if (!RANKS.includes(rank) || !SUITS.includes(suit)) return null;
    cards.push(rank + suit);
  }
  return cards;
}

export function hasDuplicates(cards: string[]): boolean {
  return new Set(cards).size !== cards.length;
}

function toCard(card: string): Card {
  return { rank: RANKS.indexOf(card[0]), suit: SUITS.indexOf(card[1]) };
}

function cardId(card: string): number {
  const c = toCard(card);
  return 4 * c.rank + c.suit;
}

/**
 * Parse exactly two distinct hole cards, normalized with the higher card
 * first ("KhAh" -> "AhKh"), which postflop-solver requires for specific
 * combos. Null otherwise.
 */
export function parseHand(input: string): string | null {
  const cards = parseCards(input);
  if (!cards || cards.length !== 2 || hasDuplicates(cards)) return null;
  return cards.sort((a, b) => cardId(b) - cardId(a)).join("");
}

// ---------- range membership ----------

type Suitedness = "all" | "suited" | "offsuit";
type ComboClass = { hi: number; lo: number; suitedness: Suitedness };
type Group =
  | { kind: "classes"; classes: ComboClass[]; weight: number }
  | { kind: "specific"; cards: [string, string]; weight: number };

const COMBO = "(?:[AKQJT2-9]{2}[os]?|(?:[AKQJT2-9][cdhs]){2})";
const GROUP_RE = new RegExp(
  `^(${COMBO}(?:\\+|-${COMBO})?)(?::((?:[01](?:\\.\\d*)?)|(?:\\.\\d+)))?$`,
  "i",
);

function parseClass(combo: string): ComboClass | null {
  const hi = RANKS.indexOf(combo[0].toUpperCase());
  const lo = RANKS.indexOf(combo[1].toUpperCase());
  const s = combo[2];
  const suitedness: Suitedness = s === "s" ? "suited" : s === "o" ? "offsuit" : "all";
  if (hi < lo) return null;
  if (hi === lo && suitedness !== "all") return null;
  return { hi, lo, suitedness };
}

function parseGroup(group: string): Group | null {
  const m = GROUP_RE.exec(group);
  if (!m) return null;
  const body = m[1];
  const weight = m[2] === undefined ? 1 : Number(m[2]);
  if (!(weight >= 0 && weight <= 1)) return null;

  // Specific combo, e.g. "AsAh".
  if (body.length === 4 && !body.includes("-") && !body.includes("+")) {
    const cards = parseCards(body);
    if (!cards || hasDuplicates(cards)) return null;
    if (toCard(cards[0]).rank < toCard(cards[1]).rank) return null;
    return { kind: "specific", cards: [cards[0], cards[1]], weight };
  }
  if (body.endsWith("+")) {
    const c = parseClass(body.slice(0, -1));
    if (!c || body.length - 1 > 3) return null;
    const gap = c.hi - c.lo;
    const classes: ComboClass[] = [];
    if (gap <= 1) {
      for (let i = c.hi; i < 13; i++) classes.push({ hi: i, lo: i - gap, suitedness: c.suitedness });
    } else {
      for (let i = c.lo; i < c.hi; i++) classes.push({ hi: c.hi, lo: i, suitedness: c.suitedness });
    }
    return { kind: "classes", classes, weight };
  }
  if (body.includes("-")) {
    const [a, b] = body.split("-");
    if (a.length > 3 || b.length > 3) return null;
    // The solver service flips ascending dash ranges ("22-JJ"), so accept both orders.
    let c1 = parseClass(a);
    let c2 = parseClass(b);
    if (c1 && c2 && (c1.hi < c2.hi || (c1.hi === c2.hi && c1.lo < c2.lo))) [c1, c2] = [c2, c1];
    if (!c1 || !c2 || c1.suitedness !== c2.suitedness) return null;
    const gap1 = c1.hi - c1.lo;
    const gap2 = c2.hi - c2.lo;
    const classes: ComboClass[] = [];
    if (gap1 === gap2) {
      if (c1.hi <= c2.hi) return null;
      for (let i = c2.hi; i <= c1.hi; i++) classes.push({ hi: i, lo: i - gap1, suitedness: c1.suitedness });
    } else if (c1.hi === c2.hi) {
      if (c1.lo <= c2.lo) return null;
      for (let i = c2.lo; i <= c1.lo; i++) classes.push({ hi: c1.hi, lo: i, suitedness: c1.suitedness });
    } else {
      return null;
    }
    return { kind: "classes", classes, weight };
  }
  const c = parseClass(body);
  return c ? { kind: "classes", classes: [c], weight } : null;
}

function groupCovers(group: Group, hand: [Card, Card], cards: [string, string]): boolean {
  if (group.kind === "specific") {
    return (
      (group.cards[0] === cards[0] && group.cards[1] === cards[1]) ||
      (group.cards[0] === cards[1] && group.cards[1] === cards[0])
    );
  }
  const hi = Math.max(hand[0].rank, hand[1].rank);
  const lo = Math.min(hand[0].rank, hand[1].rank);
  const suited = hand[0].suit === hand[1].suit;
  return group.classes.some(
    (c) =>
      c.hi === hi &&
      c.lo === lo &&
      (c.suitedness === "all" || (c.suitedness === "suited") === suited),
  );
}

/**
 * Weight of a specific hand ("AhKh") in a range string, or null if the range
 * can't be parsed. postflop-solver applies groups right to left, so the
 * first group that covers a hand determines its weight.
 */
export function handWeightInRange(range: string, hand: string): number | null {
  const cardsArr = parseCards(hand);
  if (!cardsArr || cardsArr.length !== 2) return null;
  const cards: [string, string] = [cardsArr[0], cardsArr[1]];
  const parsed: [Card, Card] = [toCard(cards[0]), toCard(cards[1])];
  const groups = range
    .replace(/\s*([-:,])\s*/g, "$1")
    .trim()
    .split(",")
    .filter((g, i, arr) => !(g === "" && i === arr.length - 1));
  let weight: number | null = null;
  for (const raw of groups) {
    const group = parseGroup(raw);
    if (!group) return null;
    if (weight === null && groupCovers(group, parsed, cards)) weight = group.weight;
  }
  return weight ?? 0;
}
