// Known villain hand (SPEC §4 `villain_hand`): "he shows 72o". Pure helpers that read
// the extracted hand as exact cards or a hand class and count the combos left after
// the board and hero's cards.
import { parseCards, parseHand } from "./poker";

const RANKS = "23456789TJQKA";
const SUITS = "cdhs";

export type VillainHand = {
  /** "7c2d" (exact) or "72o" / "72s" / "77" / "72". */
  label: string;
  /** Range string for villain's seat (crate syntax). */
  range: string;
  /** Live combos after the board and hero's cards. */
  combos: number;
};

/**
 * Parses the extraction's villain hand: exact cards, or a class with ranks in either
 * order ("27o", "72 off", "72 offsuit", "72s", "77", "72"). `dead` = board + hero cards.
 * Null when it can't be read; `combos` is 0 when every combo is blocked.
 */
export function readVillainHand(input: string, dead: string[]): VillainHand | null {
  const exact = parseHand(input);
  if (exact) {
    const live = parseCards(exact)!.every((c) => !dead.includes(c));
    return { label: exact, range: exact, combos: live ? 1 : 0 };
  }
  const m = /^\s*([2-9TJQKA]|10)\s*([2-9TJQKA]|10)\s*(s|o|suited|off|offsuit)?\s*$/i.exec(input);
  if (!m) return null;
  const r = (s: string) => RANKS.indexOf(s === "10" ? "T" : s.toUpperCase());
  let [hi, lo] = [r(m[1]), r(m[2])];
  if (hi < lo) [hi, lo] = [lo, hi];
  const kind = (m[3] ?? "").toLowerCase();
  const suited = kind === "s" || kind === "suited";
  const offsuit = kind.startsWith("o");
  const name = `${RANKS[hi]}${RANKS[lo]}`;
  const label = hi === lo ? name : suited ? `${name}s` : offsuit ? `${name}o` : name;
  let combos = 0;
  for (let s1 = 0; s1 < 4; s1++) {
    for (let s2 = 0; s2 < 4; s2++) {
      if (hi === lo ? s2 <= s1 : (suited && s1 !== s2) || (offsuit && s1 === s2)) continue;
      const cards = [RANKS[hi] + SUITS[s1], RANKS[lo] + SUITS[s2]];
      if (cards.every((c) => !dead.includes(c))) combos++;
    }
  }
  return { label, range: hi === lo || suited || offsuit ? label : `${name}s,${name}o`, combos };
}
