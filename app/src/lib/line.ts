// Earlier-street line for turn/river spots (SPEC §5, §7 "line"). Pure helpers:
// map the history's line to the solver's `line` field (hero/villain -> OOP/IP,
// bb -> chips) and turn the solver's `narrowing` result into assumptions.
import type { LineStep, LineStreet } from "./history";
import { bbToChips, chipsToBb } from "./poker";
import type { Player, SolverLineAction, SolverNarrowing } from "./types";

/** Pot and stack at the start of the flop, plus the streets between the flop and the spot. */
export type SpotLine = { flopPotBb: number; flopStackBb: number; streets: LineStreet[] };

export const NO_LINE_ASSUMPTION = "No earlier action given: ranges are full preflop ranges.";
export const USER_RANGES_NO_LINE = "Ranges not narrowed by the earlier betting (you gave the ranges)";
export const POT_TOO_SMALL_NO_LINE = "Ranges not narrowed: the stated pot is smaller than the earlier bets";

const fmt = (n: number) => String(Math.round(n * 100) / 100);

function playerOf(actor: LineStep["actor"], heroPlayer: Player): Player {
  if (actor === "hero") return heroPlayer;
  return heroPlayer === "oop" ? "ip" : "oop";
}

/** The solver's `line`: every street before the current one; a street with no action given (or two checks in any order) is OOP check, IP check. */
export function toSolverLine(line: SpotLine, heroPlayer: Player): SolverLineAction[] {
  const out: SolverLineAction[] = [];
  for (const { street, steps } of line.streets) {
    // "Both check" is often extracted hero-first; a checked-through street has one order.
    const checkedThrough = steps !== null && steps.length === 2 && steps.every((s) => s.action === "check");
    if (steps === null || checkedThrough) {
      out.push({ street, player: "oop", action: "check", amount_chips: null });
      out.push({ street, player: "ip", action: "check", amount_chips: null });
      continue;
    }
    for (const s of steps) {
      const sized = s.action === "bet" || s.action === "raise";
      out.push({
        street,
        player: playerOf(s.actor, heroPlayer),
        action: s.action,
        amount_chips: sized && s.amountBb !== null ? bbToChips(s.amountBb) : null,
      });
    }
  }
  return out;
}

const PAST: Record<LineStep["action"], string> = {
  check: "checked",
  bet: "bet",
  call: "called",
  raise: "raised to",
  fold: "folded",
};

/** "villain checked, you bet 25bb, villain called on the flop; checked through on the turn". */
export function describeLine(line: SpotLine): string {
  return line.streets
    .map(({ street, steps }) => {
      if (steps === null) return `checked through on the ${street}`;
      const parts = steps.map((s) => {
        const who = s.actor === "hero" ? "you" : "villain";
        const amount = s.amountBb !== null && (s.action === "bet" || s.action === "raise") ? ` ${fmt(s.amountBb)}bb` : "";
        return `${who} ${PAST[s.action]}${amount}`;
      });
      return `${parts.join(", ")} on the ${street}`;
    })
    .join("; ");
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The flop solve's sizes, per line street: "Flop model: both players bet 33%/75%, no raises;
 * your 25bb bet (from your line) added." With an IP preflop raiser the OOP caller doesn't
 * lead: "Flop model: you bet 33%/75%, villain doesn't lead, no raises; …". A clause the line
 * contradicts is dropped or narrowed: "Flop model: you bet 33%/75%, no raises; villain's 4bb
 * lead (from your line) added." Then "Later streets: one bet size, no raises or leads into
 * the last bettor."
 */
function streetModels(n: SolverNarrowing, line: SpotLine, heroPlayer: Player): string[] {
  if (!n.line_bets) return [];
  const bets = n.line_bets.split(/,\s*/).join("/");
  const out = line.streets.map(({ street, steps }) => {
    const noLead = street === "flop" && n.line_aggressor === "ip";
    const oopActor = heroPlayer === "oop" ? "hero" : "villain";
    // A bet is into no bet, so an OOP bet on the flop is a lead.
    const leads = noLead && (steps ?? []).some((s) => s.actor === oopActor && s.action === "bet");
    const raised = (steps ?? []).some((s) => s.action === "raise");
    const raises = n.line_raises
      ? ` and raise ${n.line_raises.split(/,\s*/).join("/")}`
      : raised
        ? ", no other raises"
        : ", no raises";
    const added = n.sizes
      .filter((s) => s.street === street && s.added)
      .map((s) => {
        const owner = s.player === heroPlayer ? "your" : "villain's";
        const amt = `${fmt(chipsToBb(s.requested))}bb`;
        if (s.action === "allin") return `${owner} ${amt} all-in`;
        if (s.action === "raise") return `${owner} raise to ${amt}`;
        return `${owner} ${amt} ${noLead && s.player === "oop" ? "lead" : "bet"}`;
      });
    const aggressor = heroPlayer === "ip" ? "you bet" : "villain bets";
    const caller = heroPlayer === "oop" ? "you don't" : "villain doesn't";
    const who = noLead ? `${aggressor} ${bets}${leads ? "" : `, ${caller} lead`}` : `both players bet ${bets}`;
    const list = added.length ? `; ${added.join(", ")} (from your line) added` : "";
    return `${capitalize(street)} model: ${who}${raises}${list}.`;
  });
  out.push("Later streets: one bet size, no raises or leads into the last bettor.");
  return out;
}

/** "~2%" for a line probability; "under 1%" below that. */
export function fmtLineShare(p: number): string {
  return p < 0.01 ? "under 1%" : `~${Math.round(p * 100)}%`;
}

/** Assumption for a player whose rare line made the solver blend their range toward the starting range. */
export function rareLineAssumption(isHero: boolean, probability: number): string {
  const share = fmtLineShare(probability);
  return isHero
    ? `Your line is unusual at equilibrium (${share} of your range) — your range is a rough estimate blended toward your starting range.`
    : `Villain's line is unusual at equilibrium (${share} of his range) — his range is a rough estimate blended toward his starting range.`;
}

/** Assumptions for the solver's narrowing result. Empty when the request had no line. */
export function narrowingAssumptions(
  n: SolverNarrowing | undefined,
  line: SpotLine | null,
  heroPlayer: Player,
): string[] {
  if (!n || !line) return [];
  if (!n.narrowed) {
    return [`Ranges not narrowed (${n.reason ?? "the line couldn't be replayed"}): full preflop ranges used`];
  }
  const out = [
    [`Ranges narrowed by a simplified flop solve of your line (${describeLine(line)}).`, ...streetModels(n, line, heroPlayer)].join(" "),
  ];
  for (const s of n.sizes) {
    if (s.used === null || s.used === s.requested) continue;
    const whose = s.player === heroPlayer ? "Your" : "Villain's";
    out.push(
      `${whose} ${fmt(chipsToBb(s.requested))}bb ${s.street} ${s.action} was solved as ${fmt(chipsToBb(s.used))}bb (the closest size the flop tree allows)`,
    );
  }
  const villainPlayer: Player = heroPlayer === "oop" ? "ip" : "oop";
  for (const p of [villainPlayer, heroPlayer]) {
    const r = n.ranges?.[p];
    if (r?.blended && typeof r.line_probability === "number") out.push(rareLineAssumption(p === heroPlayer, r.line_probability));
  }
  if (n.hero_floored) {
    out.push("Your hand almost never takes this line in the flop solve; it was kept in your range at a small weight so its strategy can be shown");
  }
  return out;
}
