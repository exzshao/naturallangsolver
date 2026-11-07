// Action-history derivation (SPEC §5). Pure functions that turn the
// extracted betting line into a pot type, hero's seat order, and the pot and
// per-player investment at the start of the current street, in big blinds.
//
// Blind rule: a blind posted by a player in the hand is part of that player's
// raise-to / call amount (BB 3-betting to 12bb has put in 12bb total, blind
// included). Blinds posted by seats that aren't in the hand are dead money
// added to the pot. With the default BTN vs BB that's the 0.5bb small blind;
// CO vs BTN adds 1.5bb; SB vs BB adds nothing.
import type { Action, Extraction, Position, PotType, Street } from "./schema";

type Postflop = Exclude<Street, "preflop">;
type Actor = Action["actor"];

const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river"];
const POSTFLOP: Postflop[] = ["flop", "turn", "river"];
const RAISE_KINDS = new Set<Action["action"]>(["open", "raise", "3bet", "4bet"]);
/** Minimum preflop raise level each kind implies (open = 1 raise, 3bet = 2, ...). */
const RAISE_LEVEL: Partial<Record<Action["action"], number>> = { open: 1, raise: 0, "3bet": 2, "4bet": 3 };
const KIND_LABEL: Partial<Record<Action["action"], string>> = { "3bet": "3-bet", "4bet": "4-bet" };
const BLINDS: Partial<Record<Position, number>> = { SB: 0.5, BB: 1 };
const TOTAL_BLINDS = 1.5;
/** Assumed open size when inferring the big blind from an open. */
export const ASSUMED_OPEN_BB = 3;
/** Sizes used when the user described a bet or raise without an amount. */
const MISSING_BET_POT_FRACTION = 0.5;
const MISSING_RAISE_MULTIPLE = 3;

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const isBetOrRaise = (a: Action) => a.action === "bet" || RAISE_KINDS.has(a.action);
const who = (actor: Actor) => (actor === "hero" ? "you" : "villain");
const whose = (actor: Actor) => (actor === "hero" ? "your" : "villain's");

function streetIndex(s: Street) {
  return STREET_ORDER.indexOf(s);
}

/** Pot type implied by preflop action: open + 3bet -> 3bet, limp only -> limped. Null if unclear. */
export function inferPotType(actions: Action[] | null): PotType | null {
  const pre = (actions ?? []).filter((a) => a.street === "preflop");
  let level = 0;
  for (const a of pre) {
    if (RAISE_KINDS.has(a.action)) level = Math.max(level + 1, RAISE_LEVEL[a.action] ?? 0);
  }
  if (level >= 3) return "4bet";
  if (level === 2) return "3bet";
  if (level === 1) return "srp";
  return pre.some((a) => a.action === "limp") ? "limped" : null;
}

/**
 * Whether hero is in position, from who acts first after the flop (the first
 * actor on a postflop street is OOP). Null if there's no postflop action.
 */
export function inferHeroIp(actions: Action[] | null): boolean | null {
  for (const s of POSTFLOP) {
    const first = (actions ?? []).find((a) => a.street === s);
    if (first) return first.actor === "villain";
  }
  return null;
}

/**
 * Big blinds per user unit. Bare amounts with no stated big blind are sized
 * off the preflop open, assumed to be a 3x raise.
 */
export function bbPerUnit(x: Pick<Extraction, "amount_unit" | "big_blind_size" | "actions">): {
  factor: number | null;
  assumption: string | null;
} {
  if (x.amount_unit === "bb") return { factor: 1, assumption: null };
  if (x.big_blind_size !== null && x.big_blind_size > 0) return { factor: 1 / x.big_blind_size, assumption: null };
  const open = (x.actions ?? []).find((a) => a.street === "preflop" && RAISE_KINDS.has(a.action));
  if (!open || open.amount === null || !(open.amount > 0)) return { factor: null, assumption: null };
  const bb = open.amount / ASSUMED_OPEN_BB;
  return {
    factor: 1 / bb,
    assumption: `Assumed a ${fmt(bb)} big blind (${whose(open.actor)} ${fmt(open.amount)} open as a standard ${ASSUMED_OPEN_BB}x raise)`,
  };
}

/**
 * Inconsistent amounts that make the line impossible: non-positive amounts,
 * or a raise that isn't bigger than the bet it raises. Compared in the user's
 * own units, so it needs no big blind. Returns a message or null.
 */
export function historyProblem(x: Pick<Extraction, "amount_unit" | "big_blind_size" | "actions">): string | null {
  if (x.big_blind_size !== null && !(x.big_blind_size > 0)) return "the big blind has to be positive";
  const actions = x.actions ?? [];
  if (actions.some((a) => a.amount !== null && !(a.amount > 0))) return "bet amounts have to be positive";
  const known = x.amount_unit === "bb" ? 1 : x.big_blind_size;
  for (const s of STREET_ORDER) {
    let current = s === "preflop" && known ? known : 0;
    for (const a of actions.filter((b) => b.street === s && isBetOrRaise(b))) {
      if (a.amount === null) continue;
      if (a.amount <= current) return `a ${a.action} to ${fmt(a.amount)} on the ${s} isn't bigger than the bet before it`;
      current = a.amount;
    }
  }
  return null;
}

export type HistoryPot = {
  potBb: number;
  /** What each player has put in so far (equal once every street is closed). */
  investedBb: number;
  assumptions: string[];
};

type Ctx = {
  street: Postflop;
  heroPosition: Position;
  villainPosition: Position;
  /** Standard pot / per-player investment at the flop, used when preflop amounts are unknown. */
  standardFlop: { potBb: number; investedBb: number };
  potLabel: string;
};

/**
 * Pot and investment at the start of `ctx.street` from the action history.
 * Returns null when the history adds nothing to the pot-type defaults (no
 * action on an earlier street, or only preflop action without amounts);
 * callers then fall back to those defaults.
 */
export function potFromHistory(
  x: Pick<Extraction, "amount_unit" | "big_blind_size" | "actions">,
  ctx: Ctx,
): HistoryPot | null {
  const before = (x.actions ?? []).filter((a) => streetIndex(a.street) < streetIndex(ctx.street));
  const pre = before.filter((a) => a.street === "preflop");
  const preRaises = pre.filter((a) => RAISE_KINDS.has(a.action));
  const { factor, assumption: bbAssumption } = bbPerUnit(x);
  const toBb = (a: Action) => (a.amount !== null && factor !== null ? a.amount * factor : null);
  const preKnown =
    pre.length > 0 &&
    preRaises.every((a) => toBb(a) !== null) &&
    (preRaises.length > 0 || pre.some((a) => a.action === "limp"));
  if (!preKnown && !before.some((a) => a.street !== "preflop")) return null;

  const assumptions: string[] = [];
  if (bbAssumption && before.some((a) => a.amount !== null)) assumptions.push(bbAssumption);
  const unitLabel = (a: Action) => (a.amount === null ? "" : ` ${fmt(a.amount)}${x.amount_unit === "bb" ? "bb" : ""}`);

  /** Closes a street: an unmatched bet or raise is assumed called. */
  const close = (c: Record<Actor, number>, last: { actor: Actor; action: Action } | null, street: Street) => {
    if (c.hero === c.villain || !last) return;
    const caller: Actor = c.hero < c.villain ? "hero" : "villain";
    const kind = KIND_LABEL[last.action.action] ?? last.action.action;
    assumptions.push(`Assumed ${who(caller)} called ${whose(last.actor)}${unitLabel(last.action)} ${kind} ${street === "preflop" ? "preflop" : `on the ${street}`}`);
    c[caller] = Math.max(c.hero, c.villain);
  };

  // Preflop
  let pot: number;
  let invested: number;
  if (preKnown) {
    const heroBlind = BLINDS[ctx.heroPosition] ?? 0;
    const villainBlind = BLINDS[ctx.villainPosition] ?? 0;
    const c: Record<Actor, number> = { hero: heroBlind, villain: villainBlind };
    let current = 1;
    let last: { actor: Actor; action: Action } | null = null;
    for (const a of pre) {
      if (a.action === "limp") c[a.actor] = Math.max(c[a.actor], 1);
      else if (a.action === "call") c[a.actor] = current;
      else if (RAISE_KINDS.has(a.action)) {
        current = toBb(a)!;
        c[a.actor] = current;
        last = { actor: a.actor, action: a };
      }
    }
    // A limped pot with no recorded raise: everyone's in for 1bb.
    if (!last) c.hero = c.villain = Math.max(c.hero, c.villain, 1);
    close(c, last, "preflop");
    const dead = TOTAL_BLINDS - heroBlind - villainBlind;
    pot = c.hero + c.villain + dead;
    invested = c.hero;
    if (dead > 0) {
      const deadLabel = dead === 0.5 ? "the 0.5bb small blind" : dead === 1 ? "the 1bb big blind" : `${fmt(dead)}bb of blinds`;
      assumptions.push(`Counted ${deadLabel} as dead money (${ctx.heroPosition} vs ${ctx.villainPosition})`);
    }
  } else {
    pot = ctx.standardFlop.potBb;
    invested = ctx.standardFlop.investedBb;
    assumptions.push(`Assumed a ${fmt(pot)}bb pot (standard ${ctx.potLabel} at the flop)`);
  }

  // Postflop streets before the current one
  const checkedThrough: Postflop[] = [];
  for (const s of POSTFLOP.slice(0, POSTFLOP.indexOf(ctx.street))) {
    const acts = before.filter((a) => a.street === s);
    if (acts.length === 0) {
      checkedThrough.push(s);
      continue;
    }
    const c: Record<Actor, number> = { hero: 0, villain: 0 };
    let current = 0;
    let last: { actor: Actor; action: Action } | null = null;
    for (const a of acts) {
      if (a.action === "call") c[a.actor] = current;
      else if (isBetOrRaise(a)) {
        // "Raise" into a check is a bet; a "bet" facing a bet is a raise.
        let to = toBb(a);
        if (to === null) {
          to = current === 0 ? (pot * MISSING_BET_POT_FRACTION) : current * MISSING_RAISE_MULTIPLE;
          assumptions.push(
            current === 0
              ? `Assumed ${whose(a.actor)} ${s} bet was half pot (size not given in big blinds)`
              : `Assumed ${whose(a.actor)} ${s} raise was ${MISSING_RAISE_MULTIPLE}x (size not given in big blinds)`,
          );
        }
        current = to;
        c[a.actor] = to;
        last = { actor: a.actor, action: a };
      }
    }
    close(c, last, s);
    pot += c.hero + c.villain;
    invested += c.hero;
  }
  if (checkedThrough.length > 0) {
    assumptions.push(`Assumed the ${checkedThrough.join(" and ")} checked through`);
  }
  return { potBb: pot, investedBb: invested, assumptions };
}
