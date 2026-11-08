// Qualitative solver benchmark: posts each spot in spots.json to the running
// app (/api/solve, plain JSON), checks the result against well-established
// poker principles and sanity rules, prints a PASS/FAIL table and saves
// benchmark/results-<date>.json. Calls the real LLM, so it only runs with
// RUN_BENCHMARK=1 (`npm run benchmark`).
//
//   npm run benchmark                         # all spots
//   npm run benchmark -- --only id1,id2       # a subset
//   BENCH_URL=http://localhost:3000 npm run benchmark
//
// Node runs this file directly (type stripping), so it is self-contained:
// only type imports from src/.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DisplayAction, SolveApiResponse, SolveOkPayload } from "../src/lib/present";

type Check = {
  type:
    | "heroFreq"
    | "heroBestIn"
    | "heroBestNot"
    | "evEdge"
    | "evEdgeNot"
    | "rangeFreq"
    | "equityVsHand"
    | "allInCallEv"
    | "narrowed"
    | "streetMatched"
    | "villainHand";
  why?: string;
  /**
   * The check also passes when hero's two best EVs are within this share of the pot at the
   * node (or EV_TIE_BB): the solver says the choice barely matters.
   */
  orEvClose?: number;
  actions?: string[];
  min?: number;
  max?: number;
  player?: "oop" | "ip";
  best?: string[];
  /** evEdge/evEdgeNot: minimum EV(best) − EV(second best), as a share of the node pot and in bb. */
  minPot?: number;
  minBb?: number;
  villain?: string;
  tol?: number;
  tolBb?: number;
  value?: string;
  rarePlayer?: "oop" | "ip";
};
type Spot = {
  id: string;
  tags: string[];
  text: string;
  /** Exact matches on the response's `spot`; `boardRanks` compares ranks only. */
  spot?: Record<string, unknown>;
  checks: Check[];
  maxSeconds?: number;
};
type Side = { spot: string; player: "oop" | "ip"; actions: string[] };
type Comparison = { id: string; why: string; a: Side; op: ">" | "<"; b: Side; margin?: number };
type Bench = { defaults: { maxSeconds: number }; spots: Spot[]; comparisons: Comparison[] };

type Outcome = { label: string; pass: boolean; detail: string };
type SpotResult = {
  id: string;
  pass: boolean;
  seconds: number;
  outcomes: Outcome[];
  summary: Record<string, unknown>;
  response: SolveApiResponse | { error: string };
};

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BENCH_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------- equity

const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
type C = { r: number; s: number };
const card = (t: string): C => ({ r: RANKS.indexOf(t[0]) + 2, s: SUITS.indexOf(t[1]) });
const cards = (t: string): C[] => (t.match(/../g) ?? []).map(card);
const key = (c: C) => c.r * 4 + c.s;

/** 7-card (or fewer, >= 5) hand value; larger is better. */
export function handValue(cs: C[]): number {
  const enc = (cat: number, ks: number[]) => ks.slice(0, 5).reduce((v, k, i) => v + k * 15 ** (4 - i), cat * 15 ** 5);
  /** Highest straight in `ranks` (ace also counts low); 0 if none. */
  const straightTop = (ranks: Set<number>): number => {
    const has = (r: number) => ranks.has(r === 1 ? 14 : r);
    for (let top = 14; top >= 5; top--) {
      let ok = true;
      for (let r = top; r > top - 5; r--) if (!has(r)) ok = false;
      if (ok) return top;
    }
    return 0;
  };
  const bySuit = [0, 1, 2, 3].map((s) => cs.filter((c) => c.s === s).map((c) => c.r).sort((a, b) => b - a));
  const flush = bySuit.find((rs) => rs.length >= 5);
  if (flush) {
    const sf = straightTop(new Set(flush));
    if (sf) return enc(8, [sf]);
  }
  const counts = new Map<number, number>();
  for (const c of cs) counts.set(c.r, (counts.get(c.r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const desc = [...counts.keys()].sort((a, b) => b - a);
  const rest = (...skip: number[]) => desc.filter((r) => !skip.includes(r));
  if (groups[0][1] === 4) return enc(7, [groups[0][0], ...rest(groups[0][0])]);
  if (groups[0][1] === 3 && groups[1]?.[1] >= 2) return enc(6, [groups[0][0], groups[1][0]]);
  if (flush) return enc(5, flush);
  const st = straightTop(new Set(desc));
  if (st) return enc(4, [st]);
  if (groups[0][1] === 3) return enc(3, [groups[0][0], ...rest(groups[0][0])]);
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const [p1, p2] = [groups[0][0], groups[1][0]];
    return enc(2, [p1, p2, ...rest(p1, p2)]);
  }
  if (groups[0][1] === 2) return enc(1, [groups[0][0], ...rest(groups[0][0])]);
  return enc(0, desc);
}

/** Combos of "7c2d", "72o", "72s", "77" or "72", minus dead cards. */
function expandHand(hand: string, dead: Set<number>): C[][] {
  if (/^([2-9TJQKA][cdhs]){2}$/.test(hand)) return [cards(hand)];
  const [a, b, kind] = [RANKS.indexOf(hand[0]) + 2, RANKS.indexOf(hand[1]) + 2, hand[2]];
  const out: C[][] = [];
  for (let s1 = 0; s1 < 4; s1++)
    for (let s2 = 0; s2 < 4; s2++) {
      if (a === b && s2 <= s1) continue;
      if (kind === "s" && s1 !== s2) continue;
      if (kind === "o" && s1 === s2) continue;
      const combo = [{ r: a, s: s1 }, { r: b, s: s2 }];
      if (combo.every((c) => !dead.has(key(c)))) out.push(combo);
    }
  return out;
}

/** Hero's all-in equity (ties = half) vs a known hand or class, averaged over its combos. */
export function equityVs(hero: string, villain: string, board: string): number {
  const h = cards(hero);
  const b = cards(board);
  const dead = new Set([...h, ...b].map(key));
  let total = 0;
  let n = 0;
  for (const v of expandHand(villain, dead)) {
    const used = new Set([...dead, ...v.map(key)]);
    const deck: C[] = [];
    for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) if (!used.has(r * 4 + s)) deck.push({ r, s });
    const need = 5 - b.length;
    const runouts: C[][] = need === 0 ? [[]] : need === 1 ? deck.map((c) => [c]) : [];
    if (need === 2) for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) runouts.push([deck[i], deck[j]]);
    for (const run of runouts) {
      const full = [...b, ...run];
      const hv = handValue([...h, ...full]);
      const vv = handValue([...v, ...full]);
      total += hv > vv ? 1 : hv === vv ? 0.5 : 0;
      n++;
    }
  }
  return n ? total / n : NaN;
}

function selfTest() {
  const v = (t: string) => handValue(cards(t));
  const order = ["AsKsQsJsTs", "9c9d9h9s2c", "9c9d9hKsKc", "As9s5s3s2s", "5c4d3h2sAc", "9c9d9hKsQc", "9c9dKhKsQc", "9c9dAhKsQc", "AcJd9h7s5c"];
  for (let i = 1; i < order.length; i++) if (!(v(order[i - 1]) > v(order[i]))) throw new Error(`hand evaluator: ${order[i - 1]} <= ${order[i]}`);
  if (Math.abs(equityVs("AhAd", "KcKs", "2c7d9h") - 0.92) > 0.03) throw new Error("equity self-test failed");
}

// ---------------------------------------------------------------- checks

const GROUPS: Record<string, string[]> = { aggro: ["Bet", "Raise", "AllIn"] };
const expand = (acts: string[]) => new Set(acts.flatMap((a) => GROUPS[a] ?? [a]));
const freqOf = (actions: DisplayAction[], acts: string[]) => {
  const set = expand(acts);
  return actions.filter((a) => set.has(a.action)).reduce((s, a) => s + a.frequency, 0);
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** EVs closer than this are a tie (EV_TIE_BB in present.ts). */
const EV_TIE_BB = 0.1;

/** Hero's best action (by `best`), the next-best EV and the gap in bb; null without 2+ EVs. */
function evGap(hh: SolveOkPayload["heroHand"] | undefined) {
  const best = hh?.actions.find((a) => a.best);
  if (!hh || !best || best.evBb === null) return null;
  const second = hh.actions.filter((a) => a !== best && a.evBb !== null).sort((x, y) => y.evBb! - x.evBb!)[0];
  if (!second) return null;
  // `best` may be the more frequent of two tied actions, so the raw gap can be slightly negative.
  const gapBb = Math.max(0, best.evBb - second.evBb!);
  const potBb = hh.potBb;
  const text = `${best.label} +${gapBb.toFixed(2)}bb over ${second.label} (${(potBb > 0 ? (gapBb / potBb) * 100 : 0).toFixed(1)}% of ${potBb}bb pot)`;
  return { best, second, gapBb, potBb, text };
}

/** Range frequency at the first node where `player` acts. */
function rangeFreq(r: SolveOkPayload, player: "oop" | "ip", acts: string[]): number | null {
  const node = r.nodes.find((n) => n.player === player);
  return node ? freqOf(node.actions, acts) : null;
}

function runCheck(c: Check, r: SolveOkPayload): Outcome {
  const hh = r.heroHand;
  const g = evGap(hh);
  const best = hh?.actions.find((a) => a.best) ?? null;
  const range = (min?: number, max?: number) => `${min !== undefined ? `>=${pct(min)}` : ""}${max !== undefined ? `<=${pct(max)}` : ""}`;
  const inRange = (x: number, min?: number, max?: number) => (min === undefined || x >= min - 1e-9) && (max === undefined || x <= max + 1e-9);
  let pass = false;
  let label: string = c.type;
  let detail = "";
  switch (c.type) {
    case "heroFreq": {
      label = `hero ${c.actions!.join("+")} ${range(c.min, c.max)}`;
      if (!hh) { detail = "no hero hand"; break; }
      const f = freqOf(hh.actions, c.actions!);
      pass = inRange(f, c.min, c.max);
      detail = pct(f);
      break;
    }
    case "heroBestIn":
    case "heroBestNot": {
      const set = expand(c.actions!);
      label = `hero best ${c.type === "heroBestIn" ? "in" : "not"} ${c.actions!.join("/")}`;
      if (!best) { detail = "no best action"; break; }
      pass = c.type === "heroBestIn" ? set.has(best.action) : !set.has(best.action);
      detail = best.label;
      break;
    }
    case "evEdge":
    case "evEdgeNot": {
      const edge = `${c.best ? `${c.best.join("/")} ` : ""}best by >=${pct(c.minPot ?? 0)} pot & >=${c.minBb ?? 0}bb`;
      label = c.type === "evEdge" ? edge : `not ${edge}`;
      if (!g) { detail = "fewer than two EVs"; break; }
      const hit =
        (!c.best || expand(c.best).has(g.best.action)) && g.gapBb >= Math.max(c.minBb ?? 0, (c.minPot ?? 0) * g.potBb);
      pass = c.type === "evEdge" ? hit : !hit;
      detail = g.text;
      break;
    }
    case "rangeFreq": {
      label = `${c.player} range ${c.actions!.join("+")} ${range(c.min, c.max)}`;
      const f = rangeFreq(r, c.player!, c.actions!);
      if (f === null) { detail = `no ${c.player} node`; break; }
      pass = inRange(f, c.min, c.max);
      detail = pct(f);
      break;
    }
    case "equityVsHand": {
      label = `equity vs ${c.villain} ±${c.tol}`;
      if (!hh || !r.spot.heroHand) { detail = "no hero hand"; break; }
      const eq = equityVs(r.spot.heroHand, c.villain!, r.spot.board);
      pass = Math.abs(hh.equity - eq) <= c.tol!;
      detail = `solver ${hh.equity.toFixed(3)} vs calc ${eq.toFixed(3)}`;
      break;
    }
    case "allInCallEv": {
      label = `EV(call) vs calc ±${c.tolBb}bb`;
      const call = hh?.actions.find((a) => a.action === "Call");
      const toCall = call ? Number(/([\d.]+)bb/.exec(call.label)?.[1]) : NaN;
      if (!hh || !call || call.evBb === null || !Number.isFinite(toCall) || !r.spot.heroHand) { detail = "no call EV"; break; }
      const eq = equityVs(r.spot.heroHand, c.villain!, r.spot.board);
      // Villain shoved first on this street: final pot = street-start pot + both stacks' calls.
      const ev = eq * (r.spot.potBb + 2 * toCall) - toCall;
      pass = Math.abs(call.evBb - ev) <= c.tolBb!;
      detail = `solver ${call.evBb.toFixed(2)} vs calc ${ev.toFixed(2)}`;
      break;
    }
    case "narrowed": {
      label = c.rarePlayer ? `narrowed, ${c.rarePlayer} rare line` : "narrowed";
      const n = r.narrowing;
      if (!n) { detail = "not narrowed"; break; }
      const p = c.rarePlayer ? n.players[c.rarePlayer] : null;
      pass = !p || p.blended || (p.lineProbability !== null && p.lineProbability <= 0.05);
      detail = p ? `line p=${p.lineProbability === null ? "?" : pct(p.lineProbability)} blended=${p.blended}` : `${Math.round(n.players.oop.combosAfter)}/${Math.round(n.players.ip.combosAfter)} combos`;
      break;
    }
    case "streetMatched":
      label = "street walked";
      pass = !!r.streetLine?.matched;
      detail = String(r.streetLine?.matched ?? "none");
      break;
    case "villainHand":
      label = `villain hand ${c.value}`;
      pass = r.villainHand === c.value;
      detail = String(r.villainHand);
      break;
  }
  if (!pass && c.orEvClose !== undefined && g && g.gapBb <= Math.max(EV_TIE_BB, c.orEvClose * g.potBb)) {
    pass = true;
    detail += ` (ok: EVs within ${g.gapBb.toFixed(2)}bb)`;
  }
  return { label, pass, detail };
}

function spotChecks(spot: Spot, r: SolveOkPayload): Outcome[] {
  const out: Outcome[] = [];
  for (const [k, want] of Object.entries(spot.spot ?? {})) {
    if (k === "boardRanks") {
      const got = r.spot.board.replace(/[cdhs]/g, "");
      out.push({ label: "board ranks", pass: got === want, detail: got });
      continue;
    }
    const got = (r.spot as Record<string, unknown>)[k];
    // Hands compare as card sets ("QcQd" = "QdQc").
    const norm = (v: unknown) => (k === "heroHand" && typeof v === "string" ? (v.match(/../g) ?? []).sort().join("") : v);
    out.push({ label: `spot.${k}=${want}`, pass: norm(got) === norm(want), detail: String(got) });
  }
  return out;
}

// ---------------------------------------------------------------- run

function summarize(r: SolveOkPayload) {
  const hh = r.heroHand;
  const node = (p: "oop" | "ip") => r.nodes.find((n) => n.player === p);
  const freqs = (as: DisplayAction[]) => as.map((a) => `${a.label} ${pct(a.frequency)}`).join(", ");
  return {
    spot: `${r.spot.street} ${r.spot.potType} ${r.spot.heroPosition}(${r.spot.heroPlayer}) v ${r.spot.villainPosition} ${r.spot.board} ${r.spot.heroHand ?? "-"} pot ${r.spot.potBb} stack ${r.spot.effectiveStackBb}`,
    hero: hh ? hh.actions.map((a) => `${a.label} ${pct(a.frequency)} ev ${a.evBb}`).join(" | ") : null,
    heroEquity: hh?.equity ?? null,
    evGap: evGap(hh)?.text ?? null,
    oopNode: node("oop") ? `${node("oop")!.title}: ${freqs(node("oop")!.actions)}` : null,
    ipNode: node("ip") ? `${node("ip")!.title}: ${freqs(node("ip")!.actions)}` : null,
    narrowing: r.narrowing
      ? Object.fromEntries((["oop", "ip"] as const).map((p) => [p, { combos: Math.round(r.narrowing!.players[p].combosAfter), lineProbability: r.narrowing!.players[p].lineProbability, blended: r.narrowing!.players[p].blended }]))
      : null,
    solveMs: r.stats.solveMs,
    exploitabilityPct: r.stats.exploitabilityPct,
    assumptions: r.assumptions,
  };
}

async function solve(text: string): Promise<SolveApiResponse | { error: string }> {
  try {
    const res = await fetch(`${BASE}/api/solve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(280_000),
    });
    return (await res.json()) as SolveApiResponse;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function runSpot(spot: Spot, maxSeconds: number): Promise<SpotResult> {
  const t0 = Date.now();
  const response = await solve(spot.text);
  const seconds = (Date.now() - t0) / 1000;
  const outcomes: Outcome[] = [];
  let summary: Record<string, unknown> = {};
  if ("error" in response) {
    outcomes.push({ label: "status ok", pass: false, detail: response.error });
  } else if (response.status !== "ok") {
    outcomes.push({ label: "status ok", pass: false, detail: `${response.reason}: ${response.message}` });
  } else {
    outcomes.push({ label: "status ok", pass: true, detail: "ok" });
    outcomes.push(...spotChecks(spot, response));
    outcomes.push(...spot.checks.map((c) => runCheck(c, response)));
    summary = summarize(response);
  }
  const limit = spot.maxSeconds ?? maxSeconds;
  outcomes.push({ label: `time <=${limit}s`, pass: seconds <= limit, detail: `${seconds.toFixed(1)}s` });
  return { id: spot.id, pass: outcomes.every((o) => o.pass), seconds, outcomes, summary, response };
}

function compare(c: Comparison, results: Map<string, SpotResult>): Outcome | null {
  const val = (s: Side) => {
    const r = results.get(s.spot)?.response;
    return r && "status" in r && r.status === "ok" ? rangeFreq(r, s.player, s.actions) : null;
  };
  if (!results.has(c.a.spot) || !results.has(c.b.spot)) return null;
  const [a, b] = [val(c.a), val(c.b)];
  if (a === null || b === null) return { label: c.id, pass: false, detail: "missing node" };
  const m = c.margin ?? 0;
  const pass = c.op === ">" ? a > b + m : a < b - m;
  return { label: c.id, pass, detail: `${c.a.spot} ${pct(a)} ${c.op} ${c.b.spot} ${pct(b)}` };
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

function printRow(r: SpotResult) {
  const ok = r.response && "status" in r.response && r.response.status === "ok" ? (r.response as SolveOkPayload) : null;
  const hh = ok?.heroHand;
  const hero = hh ? hh.actions.map((a) => `${a.action[0]}${a.action === "AllIn" ? "A" : ""}${Math.round(a.frequency * 100)}(${a.evBb})`).join(" ") : "-";
  const range = ok
    ? (["oop", "ip"] as const)
        .map((p) => {
          const f = rangeFreq(ok, p, ["aggro"]);
          return f === null ? null : `${ok.spot[p === "oop" ? "oopPosition" : "ipPosition"]} agg ${pct(f)}`;
        })
        .filter(Boolean)
        .join(", ")
    : "-";
  console.log(
    `${r.pass ? "PASS" : "FAIL"}  ${pad(r.id, 30)} ${pad(hero, 40)} ${pad(evGap(hh)?.text ?? "-", 52)} ${pad(range, 26)} ${r.seconds.toFixed(1).padStart(5)}s`,
  );
  for (const o of r.outcomes.filter((o) => !o.pass)) console.log(`        x ${o.label}: ${o.detail}`);
}

async function main() {
  if (process.env.RUN_BENCHMARK !== "1") {
    console.log("Skipped: set RUN_BENCHMARK=1 (npm run benchmark). Calls the real LLM via the local app.");
    return;
  }
  selfTest();
  const bench = JSON.parse(readFileSync(join(HERE, "spots.json"), "utf8")) as Bench;
  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(",")) : null;
  const spots = bench.spots.filter((s) => !only || only.has(s.id));
  console.log(`Benchmark: ${spots.length} spots against ${BASE}\n`);
  console.log(`      ${pad("spot", 30)} ${pad("hero action%(EV bb)", 40)} ${pad("best EV gap", 52)} ${pad("range aggression", 26)}  time`);
  const t0 = Date.now();
  const results = new Map<string, SpotResult>();
  for (const spot of spots) {
    const r = await runSpot(spot, bench.defaults.maxSeconds);
    results.set(spot.id, r);
    printRow(r);
  }
  const comparisons = bench.comparisons.map((c) => compare(c, results)).filter((c): c is Outcome => c !== null);
  if (comparisons.length) console.log("\nComparisons:");
  for (const c of comparisons) console.log(`${c.pass ? "PASS" : "FAIL"}  ${pad(c.label, 30)} ${c.detail}`);

  const all = [...results.values()];
  const passed = all.filter((r) => r.pass).length;
  const cPassed = comparisons.filter((c) => c.pass).length;
  const totalSecs = (Date.now() - t0) / 1000;
  console.log(`\n${passed}/${all.length} spots passed, ${cPassed}/${comparisons.length} comparisons passed, ${totalSecs.toFixed(0)}s total, ${all.length} LLM calls`);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = join(HERE, `results-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, passed, total: all.length, comparisons, totalSecs, spots: all }, null, 1),
  );
  console.log(`Saved ${file}`);
  if (passed < all.length || cPassed < comparisons.length) process.exitCode = 1;
}

await main();
