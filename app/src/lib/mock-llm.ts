// Dev-only stand-in for the extraction LLM: LLM_MODEL=mock:fixture.
// Never the default, and refused when NODE_ENV=production (see llm.ts).
//
// It is NOT a real parser. It picks a canned extraction by keyword and pulls
// a board / hero hand / positions out with regexes, so the full pipeline
// (defaults, validation, solver, UI) can run without an API key:
//   - no poker words (e.g. "what's the capital of France") -> NOT_POKER
//   - "3-way" / "three-way" / "multiway"                 -> MULTIWAY
//   - "preflop"                                          -> PREFLOP
//   - "every size" / "many sizes" / "huge tree"          -> deep flop, many sizes (TREE_TOO_LARGE)
//   - "flop: villain checks, I bet 6bb, he calls"         -> that flop line in `actions` (bb)
//   - "BB checks to me" / "BB leads 75%" / "goes all in"  -> that action on the decision street
//   - "reveals his cards (72 off)" / "shows 7c2d"         -> villain_hand
//   - anything else: board/hand/positions/stacks by regex (a duplicate-card
//     board like "Td9dTd" then fails validation with INVALID_BOARD)
import { MockLanguageModelV4, MockProviderV4 } from "ai/test";
import type { Action, Extraction, Position } from "./schema";

const EMPTY: Extraction = {
  is_poker_spot: true,
  num_players: null,
  street: null,
  board: null,
  hero_position: null,
  villain_position: null,
  hero_hand: null,
  villain_hand: null,
  pot_type: null,
  pot_bb: null,
  effective_stack_bb: null,
  starting_stack_bb: null,
  amount_unit: null,
  big_blind_size: null,
  actions: null,
  oop_range: null,
  ip_range: null,
  bet_sizes: null,
  notes: null,
};

const POKER_WORDS =
  /\b(poker|flop|turn|river|board|pot|preflop|pre-flop|button|btn|bb|sb|big blind|small blind|cutoff|raise|3-?bet|check|bet|hold'?em|\d+\s*bb)\b/i;

const POSITION_WORDS: [RegExp, Position][] = [
  [/\b(BTN|button|dealer)\b/i, "BTN"],
  [/\b(BB|big blind)\b/i, "BB"],
  [/\b(SB|small blind)\b/i, "SB"],
  [/\b(CO|cut-?off)\b/i, "CO"],
  [/\b(HJ|hi-?jack)\b/i, "HJ"],
  [/\b(UTG|under the gun)\b/i, "UTG"],
];

const CARD = "[2-9TJQKA][cdhs]";
const FLOP_LINE_RE = /\bflop\b[^.]*?\b(?:villain|he) checks?,?\s+I bet (\d+(?:\.\d+)?)\s*bb,?\s+(?:villain|he) calls\b/i;
const HAND_RE = new RegExp(`\\b(?:with|holding|have|hold)\\s+((?:${CARD}){2})\\b`, "i");
const BOARD_RE = new RegExp(`\\b((?:${CARD}){3,5})\\b`, "gi");

function normCards(s: string): string {
  return s.replace(/(.)(.)/g, (_, r: string, su: string) => r.toUpperCase() + su.toLowerCase());
}

function position(fragment: string): Position | null {
  for (const [re, pos] of POSITION_WORDS) if (re.test(fragment)) return pos;
  return null;
}

function num(re: RegExp, text: string): number | null {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}

/** The canned extraction for a prompt. Exported for tests. */
export function mockExtraction(text: string): Extraction {
  if (!POKER_WORDS.test(text)) return { ...EMPTY, is_poker_spot: false };
  if (/\b(3|three|4|four)[- ]?way\b|multi-?way/i.test(text)) {
    return { ...EMPTY, num_players: 3, street: "flop", board: "Td9d6h", notes: "Three players see the flop." };
  }
  if (/\bpre-?flop\b/i.test(text)) return { ...EMPTY, street: "preflop" };
  if (/every size|many sizes|huge tree/i.test(text)) {
    return {
      ...EMPTY,
      num_players: 2,
      street: "flop",
      board: "Td9d6h",
      starting_stack_bb: 200,
      bet_sizes: { bet: "33%, 75%, 150%", raise: "3x" },
    };
  }

  const handMatch = HAND_RE.exec(text);
  const hero_hand = handMatch ? normCards(handMatch[1]) : null;
  const board =
    [...text.matchAll(BOARD_RE)].map((m) => normCards(m[1])).find((b) => b.length >= 6 && b !== hero_hand) ??
    null;
  const street = board ? (({ 6: "flop", 8: "turn", 10: "river" }) as const)[board.length as 6 | 8 | 10] : null;

  const heroClause = /\b(?:i'?m|i am|hero is)\s+(?:on|in|at)\s+(?:the\s+)?([\w-]+(?:\s+blind)?)/i.exec(text);
  const hero_position = heroClause ? position(heroClause[1]) : null;
  const mentioned = POSITION_WORDS.filter(([re]) => re.test(text)).map(([, p]) => p);
  const villain_position = mentioned.find((p) => p !== hero_position) ?? null;

  const pot_type = /\b4-?bet/i.test(text)
    ? "4bet"
    : /\b3-?bet/i.test(text)
      ? "3bet"
      : /\blimp/i.test(text)
        ? "limped"
        : /single raised|\bsrp\b/i.test(text)
          ? "srp"
          : null;

  const line = FLOP_LINE_RE.exec(text);
  const actions: Action[] | null = line
    ? [
        { street: "flop", actor: "villain", action: "check", amount: null, pot_pct: null },
        { street: "flop", actor: "hero", action: "bet", amount: Number(line[1]), pot_pct: null },
        { street: "flop", actor: "villain", action: "call", amount: null, pot_pct: null },
      ]
    : null;

  // Action on the decision street, before hero acts.
  const lead = /\b(?:villain|he|bb|sb|btn|co|hj|utg)\s+(?:leads|bets|donks|c-?bets|fires)\s+(\d+(?:\.\d+)?)\s*%/i.exec(text);
  const current: Action | null =
    street === null
      ? null
      : /\b(?:goes all[- ]in|shoves|jams|all[- ]in)\b/i.test(text)
        ? { street, actor: "villain", action: "allin", amount: null, pot_pct: null }
        : lead
          ? { street, actor: "villain", action: "bet", amount: null, pot_pct: Number(lead[1]) }
          : /\bchecks to (me|hero)\b/i.test(text)
            ? { street, actor: "villain", action: "check", amount: null, pot_pct: null }
            : null;
  const allActions = current ? [...(actions ?? []), current] : actions;
  const shown = /\b(?:reveals|shows|flashes|showed|revealed)\b[^.]*?\b((?:[2-9TJQKA][cdhs]){2}|[2-9TJQKA]{2}\s*(?:off|o|s|suited)?)\b/i.exec(text);
  const villain_hand = shown ? shown[1].replace(/\s+/g, "").replace(/off$/i, "o").replace(/suited$/i, "s") : null;

  const notes = /\bchecks to (me|hero)\b/i.test(text)
    ? `${villain_position ?? "Villain"} checks to hero.`
    : null;

  return {
    ...EMPTY,
    num_players: mentioned.length >= 2 || /heads[- ]?up/i.test(text) ? 2 : null,
    street,
    board,
    hero_position,
    villain_position,
    hero_hand,
    pot_type,
    pot_bb: num(/(\d+(?:\.\d+)?)\s*bb pot\b/i, text),
    effective_stack_bb: num(/(\d+(?:\.\d+)?)\s*bb (?:behind|effective)\b/i, text),
    starting_stack_bb: num(/(\d+(?:\.\d+)?)\s*bb deep\b/i, text),
    amount_unit: actions ? "bb" : null,
    actions: allActions,
    villain_hand,
    notes,
  };
}

function lastUserText(prompt: { role: string; content: unknown }[]): string {
  const user = [...prompt].reverse().find((m) => m.role === "user");
  if (!user || !Array.isArray(user.content)) return "";
  return user.content
    .map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : ""))
    .join(" ");
}

export const mockProvider = new MockProviderV4({
  languageModels: {
    fixture: new MockLanguageModelV4({
      provider: "mock",
      modelId: "fixture",
      doGenerate: async ({ prompt }) => ({
        content: [{ type: "text", text: JSON.stringify(mockExtraction(lastUserText(prompt))) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      }),
    }),
  },
});
