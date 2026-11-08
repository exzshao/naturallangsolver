// Current-street action (SPEC §5, §7 "street_actions"): "he bets 75%, should I call?".
// Pure helpers: pull the action on the decision street out of the extraction, size it
// in bb, map it to the solver's `street_actions`, and describe the solver's result.
import { bbPerUnit, potPctTo } from "./history";
import { bbToChips, chipsToBb } from "./poker";
import type { Action, Extraction, Street } from "./schema";
import type { Player, SolverLineAction, SolverStreetLine } from "./types";

type Postflop = Exclude<Street, "preflop">;
type Actor = Action["actor"];

export type StreetStep = {
  actor: Actor;
  action: "check" | "bet" | "raise" | "allin";
  /** Street-level bb: bet size, raise-to total, or the all-in total. Null for a check. */
  amountBb: number | null;
};

/** The action on the decision street before hero acts; always ends with villain's action. */
export type StreetLine = { street: Postflop; steps: StreetStep[] };

/** What `currentStreetLine` needs from the defaulted spot. */
export type StreetSpot = { street: Postflop; heroPlayer: Player; potBb: number; effectiveStackBb: number };

/** Sizes used when a bet or raise on the street has no amount. */
const MISSING_BET_POT_FRACTION = 0.5;
const MISSING_RAISE_MULTIPLE = 3;
const RAISE_LIKE = new Set<Action["action"]>(["bet", "raise", "open", "3bet", "4bet"]);

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const who = (a: Actor) => (a === "hero" ? "you" : "villain");
const whose = (a: Actor) => (a === "hero" ? "your" : "villain's");

/**
 * The street line from `x.actions`, plus assumptions about it. Trailing hero entries are
 * the decision being asked about and are dropped; a missing first check is filled in. A
 * line that can't end in hero's decision (a call or fold, out-of-turn action) is not used.
 */
export function currentStreetLine(
  x: Pick<Extraction, "actions" | "amount_unit" | "big_blind_size">,
  spot: StreetSpot,
): { line: StreetLine | null; assumptions: string[] } {
  const acts = (x.actions ?? []).filter((a) => a.street === spot.street);
  const assumptions: string[] = [];
  if (acts.length === 0) return { line: null, assumptions };
  const { street } = spot;

  // Hero's own trailing entries are the question ("should I call?"), not history.
  const dropped: Action[] = [];
  while (acts.length > 0 && acts[acts.length - 1].actor === "hero") dropped.unshift(acts.pop()!);
  if (dropped.length > 0) {
    assumptions.push(
      `Treated your ${dropped.map((a) => a.action).join(", ")} on the ${street} as the decision you're asking about`,
    );
  }
  if (acts.length === 0) return { line: null, assumptions };

  const skip = (why: string) => ({
    line: null,
    assumptions: [...assumptions, `Couldn't use the ${street} action (${why}): strategy starts at the beginning of the ${street}`],
  });

  // Seat order: OOP acts first on the street.
  const firstActor: Actor = spot.heroPlayer === "oop" ? "hero" : "villain";
  const steps: StreetStep[] = [];
  if (acts[0].actor !== firstActor) {
    if (!RAISE_LIKE.has(acts[0].action) && acts[0].action !== "allin" && acts[0].action !== "check") {
      return skip("it starts out of turn");
    }
    steps.push({ actor: firstActor, action: "check", amountBb: null });
    assumptions.push(`Assumed ${who(firstActor)} checked first on the ${street}`);
  }

  const { factor } = bbPerUnit(x);
  const stack = spot.effectiveStackBb;
  const put: Record<Actor, number> = { hero: 0, villain: 0 };
  for (const a of acts) {
    const prev = steps.at(-1);
    const due: Actor = prev ? (prev.actor === "hero" ? "villain" : "hero") : firstActor;
    if (a.actor !== due) return skip("the action is out of turn");
    const other: Actor = a.actor === "hero" ? "villain" : "hero";
    const facing = put[other] > put[a.actor];
    if (put[other] >= stack) return skip("it continues after an all-in");
    if (a.action === "call") return skip("a call ends the street");
    if (a.action === "fold") return skip("a fold ends the hand");
    if (a.action === "check") {
      if (facing) return skip("a check facing a bet");
      if (prev) return skip("both players checked, so the street is over");
      steps.push({ actor: a.actor, action: "check", amountBb: null });
      continue;
    }
    if (a.action === "limp") return skip(`"${a.action}" isn't a postflop action`);
    let to: number | null;
    if (a.action === "allin") {
      to = stack;
    } else {
      to = a.amount !== null && factor !== null ? a.amount * factor : potPctTo(a, spot.potBb, facing ? put[other] : 0);
      if (to === null) {
        to = facing ? put[other] * MISSING_RAISE_MULTIPLE : spot.potBb * MISSING_BET_POT_FRACTION;
        assumptions.push(
          facing
            ? `Assumed ${whose(a.actor)} ${street} raise was ${MISSING_RAISE_MULTIPLE}x (size not given in big blinds)`
            : `Assumed ${whose(a.actor)} ${street} bet was half pot (size not given in big blinds)`,
        );
      }
      if (facing && to <= put[other]) return skip("a raise isn't bigger than the bet before it");
    }
    const allin = to >= stack - 1e-9;
    steps.push({
      actor: a.actor,
      action: allin ? "allin" : facing ? "raise" : "bet",
      amountBb: allin ? stack : to,
    });
    put[a.actor] = Math.min(to, stack);
  }
  return { line: { street, steps }, assumptions };
}

function playerOf(actor: Actor, heroPlayer: Player): Player {
  if (actor === "hero") return heroPlayer;
  return heroPlayer === "oop" ? "ip" : "oop";
}

/** The solver's `street_actions` (chips; raise-to totals; all-in amounts left to the solver). */
export function toSolverStreetActions(line: StreetLine, heroPlayer: Player): SolverLineAction[] {
  return line.steps.map((s) => ({
    street: line.street,
    player: playerOf(s.actor, heroPlayer),
    action: s.action,
    amount_chips: (s.action === "bet" || s.action === "raise") && s.amountBb !== null ? bbToChips(s.amountBb) : null,
  }));
}

const PAST: Record<StreetStep["action"], string> = { check: "checked", bet: "bet", raise: "raised to", allin: "went all-in" };

/** Chips the solver actually used for each sized step, in order (falls back to the request). */
function usedBb(line: StreetLine, result: SolverStreetLine | undefined): (number | null)[] {
  let i = 0;
  return line.steps.map((s) => {
    if (s.action === "check") return null;
    const size = result?.sizes[i++];
    return size?.used != null ? chipsToBb(size.used) : s.amountBb;
  });
}

/** "villain checked, you bet 3bb, villain raised to 10bb". `villain` names villain's seat. */
export function describeStreetLine(line: StreetLine, villain = "villain", result?: SolverStreetLine): string {
  const used = usedBb(line, result);
  return line.steps
    .map((s, i) => {
      const name = s.actor === "hero" ? "you" : villain;
      const amount = used[i] !== null && s.action !== "check" ? ` ${fmt(used[i]!)}bb` : "";
      return `${name} ${PAST[s.action]}${amount}`;
    })
    .join(", ");
}

/**
 * What a player faces after `who`'s action: "after BB checks", "after you check",
 * "facing BB's 3bb bet", "facing your raise to 10bb", "facing BB's 97.5bb all-in".
 * `who` is a seat or "you".
 */
export function facingText(who: string, action: StreetStep["action"], amountBb: number | null): string {
  const you = who === "you";
  const owner = you ? "your" : `${who}'s`;
  const amt = amountBb !== null ? `${fmt(amountBb)}bb` : "";
  switch (action) {
    case "check":
      return `after ${who} ${you ? "check" : "checks"}`;
    case "bet":
      return `facing ${owner} ${amt ? `${amt} ` : ""}bet`;
    case "raise":
      return `facing ${owner} raise${amt ? ` to ${amt}` : ""}`;
    case "allin":
      return `facing ${owner} ${amt ? `${amt} ` : ""}all-in`;
  }
}

/** A player's own earlier action, for a node title: "checking", "betting 3bb", "raising to 10bb". */
export function priorText(action: StreetStep["action"], amountBb: number | null): string {
  const amt = amountBb !== null ? ` ${fmt(amountBb)}bb` : "";
  switch (action) {
    case "check":
      return "checking";
    case "bet":
      return `betting${amt}`;
    case "raise":
      return `raising to${amt}`;
    case "allin":
      return "going all-in";
  }
}

/**
 * Node title, one pattern for every node: "<seat> acts first", "<seat> after BB checks",
 * "<seat> facing your 1.8bb bet (after checking)". `last` is the action the player
 * responds to; `own` is the player's own earlier action on the street, if any.
 */
export function nodeTitleText(
  position: string,
  last: { who: string; action: StreetStep["action"]; amountBb: number | null } | null,
  own: { action: StreetStep["action"]; amountBb: number | null } | null = null,
): string {
  if (!last) return `${position} acts first`;
  const after = own ? ` (after ${priorText(own.action, own.amountBb)})` : "";
  return `${position} ${facingText(last.who, last.action, last.amountBb)}${after}`;
}

/** Title of the node reached after the first `n` steps of the street line. */
export function streetNodeTitle(
  line: StreetLine,
  n: number,
  position: string,
  villain: string,
  result?: SolverStreetLine,
): string {
  const used = usedBb(line, result);
  const step = (i: number) => (i >= 0 && i < n ? line.steps[i] : null);
  const last = step(n - 1);
  const own = step(n - 2);
  return nodeTitleText(
    position,
    last && { who: last.actor === "hero" ? "you" : villain, action: last.action, amountBb: used[n - 1] },
    own && { action: own.action, amountBb: used[n - 2] },
  );
}

/** Hero's decision: "facing BB's 97.5bb all-in", "facing BB's raise to 30bb", "after BB checks". */
export function decisionText(line: StreetLine, villain: string, result?: SolverStreetLine): string {
  const used = usedBb(line, result);
  const i = line.steps.length - 1;
  return facingText(villain, line.steps[i].action, used[i]);
}

/**
 * A size the solved tree has beyond its bet sizes: one from the described street action
 * (`described`), or the raise the solver gives hero facing a bet on a street without raises.
 */
export type AddedSize = {
  street: Postflop;
  player: Player;
  /** A bet into no bet, or a raise of one. */
  kind: "bet" | "raise";
  allin: boolean;
  /** Bet size or raise-to total, as solved. */
  amountBb: number;
  described: boolean;
};

/** Added sizes from the solver's walk of the street line (empty when it didn't match). */
export function addedStreetSizes(
  line: StreetLine | null,
  result: SolverStreetLine | undefined,
  heroPlayer: Player,
): AddedSize[] {
  if (!line || !result?.matched) return [];
  const used = usedBb(line, result);
  const out: AddedSize[] = [];
  let sized = 0;
  line.steps.forEach((s, i) => {
    if (s.action === "check") return;
    const size = result.sizes[sized];
    if (size?.added) {
      out.push({
        street: line.street,
        player: playerOf(s.actor, heroPlayer),
        kind: sized === 0 ? "bet" : "raise",
        allin: s.action === "allin",
        amountBb: used[i] ?? 0,
        described: true,
      });
    }
    sized++;
  });
  return out;
}

/**
 * One added size: "BB's 4bb lead", "your 1.8bb bet", "villain's raise to 5.5bb",
 * "BB's 97.5bb all-in". `owner` is "BB's" / "your"; a lead is an OOP bet into a player
 * whose tree gives the OOP player no bets.
 */
export function addedSizeText(a: AddedSize, owner: string, lead: boolean): string {
  const amt = `${fmt(a.amountBb)}bb`;
  if (a.allin) return `${owner} ${amt} all-in`;
  if (a.kind === "raise") return `${owner} raise to ${amt}`;
  return `${owner} ${amt} ${lead ? "lead" : "bet"}`;
}

const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** "BTN's 1.8bb bet and BB's raise to 5.5bb (from your description), BTN's raise to 16.5bb (at your decision)". */
export function addedSizesText(added: AddedSize[], owner: (p: Player) => string, lead: (a: AddedSize) => boolean): string {
  const text = (list: AddedSize[]) => joinAnd(list.map((a) => addedSizeText(a, owner(a.player), lead(a))));
  const described = added.filter((a) => a.described);
  const decision = added.filter((a) => !a.described);
  return [
    described.length ? `${text(described)} (from your description)` : "",
    decision.length ? `${text(decision)} (at your decision)` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Assumptions for the solver's walk of the street line. `added` lists the sizes added to the
 * street's tree; null when another assumption (the default flop tree's) already names them.
 */
export function streetAssumptions(
  result: SolverStreetLine | undefined,
  line: StreetLine | null,
  heroPlayer: Player,
  villainKnown: boolean,
  added: AddedSize[] | null = addedStreetSizes(line, result, heroPlayer),
): string[] {
  if (!line || !result) return [];
  const { street } = line;
  if (!result.matched) {
    return [
      `Couldn't play the ${street} action in the solver's tree (${result.reason ?? "unknown reason"}): strategy starts at the beginning of the ${street}`,
    ];
  }
  const out = [`Strategy shown at your decision after the ${street} action (${describeStreetLine(line, "villain", result)})`];
  if (added && added.length > 0) {
    const owner = (p: Player) => (p === heroPlayer ? "your" : "villain's");
    out.push(`Added to the solver's ${street} sizes: ${addedSizesText(added, owner, () => false)}`);
  }
  for (const s of result.sizes) {
    if (s.used === null || s.used === s.requested || s.action === "allin") continue;
    const whoseSize = s.player === heroPlayer ? "Your" : "Villain's";
    out.push(
      `${whoseSize} ${fmt(chipsToBb(s.requested))}bb ${street} ${s.action} was solved as ${s.used >= s.requested ? "all-in " : ""}${fmt(chipsToBb(s.used))}bb (the closest size the tree allows)`,
    );
  }
  if (result.villain_rare && !villainKnown) {
    out.push("The solver's villain almost never plays this line, so villain's whole range was assumed to take it");
  }
  return out;
}
