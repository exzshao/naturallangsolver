# Natural-Language Poker Solver: Build Spec

This is a handoff for a coding agent. Read the whole file before writing code. The repo currently holds an empty skeleton, and this document says what to build on top of it.

## 1. Goal and scope

A user describes a heads-up No-Limit Hold'em **postflop** spot in plain English, for example: *"BTN vs BB single raised pot, 100bb deep, flop Td9d6h, I'm on the button with AhKh, BB checks to me."* The app:

1. Uses an LLM to extract structured spot parameters from the text.
2. Fills in sensible defaults for anything the user didn't say, and records each one as an **assumption** shown to the user.
3. Validates the spot and sends it to a Rust service that runs a GTO solve with b-inary's `postflop-solver`.
4. Shows a compact strategy summary.

**No LLM fallback.** If the input can't be parsed into a solvable spot, or the solver fails, the app returns a fixed **"Can't solve this"** message with a short machine-readable reason. The LLM must never invent strategy, equities, or EVs. Its only job is extraction.

## 2. Architecture

```
Browser ──POST /api/solve {text}──▶ Next.js route (app/)
                                     1. extract   (LLM via AI SDK → zod object)
                                     2. defaults  (pure TS, emits assumptions[])
                                     3. validate  (pure TS, cheap checks)
                                     4. POST {SOLVER_URL}/solve ──▶ Rust solver-service (solver/)
                                     5. map result → UI response       axum + postflop-solver
Browser ◀── {status:"ok",...} | {status:"cant_solve",...}
```

- The Next.js app owns all LLM and product logic, and holds the API key server-side.
- The Rust service is stateless and deterministic. It knows nothing about LLMs or natural language. It does the authoritative validation, because the solver crate itself rejects bad configs.

### Repo layout (starting state)

```
.env                      # OPENAI_API_KEY, SOLVER_URL, LLM_MODEL (gitignored)
SPEC.md
solver/                   # Rust crate `solver-service` (edition 2024)
  Cargo.toml              # axum 0.8, tokio, serde, serde_json, tracing, tower-http(cors),
                          # postflop-solver (git, default-features=false, features=["rayon"])
  src/main.rs             # GET /health → "ok"; POST /solve → 501 stub; CORS permissive; PORT (default 8080)
app/                      # Next.js (App Router, TS, Tailwind, src/, npm)
  .env.local -> ../.env   # symlink
  src/lib/schema.ts       # placeholder: zod schemas
  src/lib/llm.ts          # placeholder: provider registry + extraction
  src/lib/solver.ts       # placeholder: HTTP client for solver-service
  src/app/api/solve/route.ts  # placeholder: returns 501
```

Add `src/lib/defaults.ts` and `src/lib/validate.ts` in the app. In `solver/src`, split the code into `main.rs` (routing), `api.rs` (request/response types), `config.rs` (turns a request into `CardConfig`/`TreeConfig`), and `summary.rs` (result extraction). Avoid naming any file `build.rs`, which Cargo reserves.

### Running locally

```
cd solver && cargo run --release     # ALWAYS --release; debug builds solve 10-50x slower
cd app && npm run dev                 # http://localhost:3000
```

`.env`: `OPENAI_API_KEY=...`, `SOLVER_URL=http://localhost:8080`, `LLM_MODEL=openai:<model-id>` (pick a current, cheap model that supports structured outputs). The solver reads `PORT`, `MAX_MEMORY_MB` (default 1024), `SOLVE_TIMEOUT_SECS` (default 90), and `MAX_ITERATIONS` (default 1000) from the process env, falling back to the defaults when unset.

## 3. Model-agnostic LLM layer (`app/src/lib/llm.ts`)

- Use the Vercel AI SDK (`ai` package). Build a registry with `createProviderRegistry({ openai })` and resolve the model with `registry.languageModel(process.env.LLM_MODEL)`, where `LLM_MODEL` is a `"provider:model"` string.
- Extract with `generateObject({ model, schema: ExtractionSchema, system, prompt: text })`. Check the installed `ai` major version's docs: newer versions may prefer `generateText` with `experimental_output`/`Output.object`. Use whichever the installed version recommends.
- **Adding a provider** means running `npm i @ai-sdk/<provider>` and adding one entry to the registry object. Nothing else should change. Keep every provider-specific option out of the rest of the code.
- **Schema gotcha:** OpenAI strict structured outputs require every property to be present. Make unknown fields `.nullable()`, not `.optional()`. Write the schema so it works with both.
- The system prompt (keep it in `app/src/lib/prompts.ts`) tells the model to extract **only what the user said**, set anything unstated to `null`, normalize cards to `Td9d6h` form, and convert stack and pot amounts to big blinds. It must never guess ranges unless the user describes them.
- Use temperature 0 where the provider supports it. Set a timeout of about 20s, and treat an LLM error or timeout as `cant_solve: LLM_UNAVAILABLE`.

## 4. Extraction schema (`app/src/lib/schema.ts`)

All fields are nullable unless marked otherwise. Here, "required" means a spot can't be solved without it; nothing gets defaulted for those.

| Field | Type | Notes |
|---|---|---|
| `is_poker_spot` | boolean (non-null) | Set to false for anything that isn't a poker hand or spot. |
| `num_players` | int | Number of players who see the flop. Anything other than 2 can't be solved. |
| `street` | `"preflop"\|"flop"\|"turn"\|"river"` | Street the decision happens on. Preflop can't be solved. |
| `board` | string | **Required.** 3, 4, or 5 cards, e.g. `"Td9d6hQc"`. The card count must match `street`. |
| `hero_position`, `villain_position` | `"UTG"\|"HJ"\|"CO"\|"BTN"\|"SB"\|"BB"` | Used to decide OOP/IP and to pick default ranges. |
| `hero_hand` | string | e.g. `"AhKh"`. Optional. Lets us report hero's strategy for that exact hand. |
| `villain_hand` | string | Villain's cards when the user says villain showed them: exact (`"7c2d"`) or a hand class (`"72o"`, `"72s"`, `"77"`, `"72"` when suitedness is unknown). |
| `pot_type` | `"limped"\|"srp"\|"3bet"\|"4bet"` | srp = single raised pot. |
| `pot_bb` | number | Pot size at the start of `street`, in bb. Null when the user's amounts can't be converted (no blind size); the pot then comes from `actions`. |
| `effective_stack_bb` | number | Effective stack at the start of `street`. |
| `starting_stack_bb` | number | Stack depth before the hand ("100bb deep"). |
| `amount_unit` | `"bb"\|"chips"` | Units of the `actions` amounts. `chips` covers chips, currency and bare numbers. |
| `big_blind_size` | number | Big blind in the same units as `actions` amounts (stakes "$1/$2" → 2). Only if stated. |
| `actions` | `[{street, actor: "hero"\|"villain", action, amount, pot_pct}]` | The betting line in order, up to and including the current street, ending just before hero's decision (the decision being asked about is never recorded). `action` is `limp\|open\|raise\|3bet\|4bet\|call\|check\|bet\|fold\|allin` ("shoves" → `allin`). `amount` is in the user's units, unconverted: raise-to total for open/raise/3bet/4bet, bet size for bet, the all-in total for allin if stated, null otherwise. `pot_pct` is a size given as a share of the pot ("75% pot" → 75; `amount` null then). A "raise" into a check is recorded as `bet`; implied calls (a street that continues) are recorded even when unstated. `pot_pct` and `villain_hand` are required in the LLM schema (strict outputs) but optional in the TS type. |
| `oop_range`, `ip_range` | string | PioSOLVER-style range string (see §6). Filled only if the user gave one. |
| `bet_sizes` | `{bet: string, raise: string}` | Filled only if the user named sizes, e.g. `"33%, 75%"`. |
| `notes` | string | Anything relevant that didn't fit (partial hand info, suits the model chose). Current-street action goes in `actions`. |

## 5. Defaults (`app/src/lib/defaults.ts`)

Every default that gets applied adds a readable line to `assumptions[]`, for example `"Assumed 100bb effective stacks (starting stack)"`. **All values are tunable.** Keep them in one exported constant.

| Missing | Default |
|---|---|
| positions | BTN (IP) vs BB (OOP). Hero takes the IP seat unless `actions` show hero acting first after the flop. |
| one position | The other comes from the pot type: srp → BB defends against the opener; 3bet → the opener calls the 3-bettor |
| pot_type | Inferred from preflop `actions` (open → srp, open + 3bet → 3bet, a 4bet → 4bet, limps only → limped), else srp |
| starting stack | 100bb |
| pot_bb / effective_stack_bb (flop) | From the standard line for the pot type and seat pair, using the preflop size table that sits next to the ranges (`PREFLOP_SIZES_100BB`, keyed by `IPvOOP`): open 2.5bb (SB 3.5bb); 3-bet to 9bb in position vs UTG/HJ, 8bb vs CO, 12bb from the SB vs UTG/HJ, 11.5bb vs CO/BTN, 13bb from the BB, 10.5bb BB v SB; 4-bet to 22.5bb vs a 9bb 3-bet, 20bb vs 8bb, 25bb vs 12bb, 24bb vs 11.5bb, 27.5bb vs 13bb, 22bb SB v BB; limped = 1bb each. Pot = both players' contributions + blinds of seats not in the hand (dead money). Effective stack = starting stack − one player's contribution. Examples: BTN v BB srp 5.5 / 97.5; CO v BTN srp 6.5 / 97.5; SB v BB srp 7 / 96.5; BTN v BB 3bet 26.5 / 87; CO v BTN 3bet 17.5 / 92; BTN v BB 4bet 55.5 / 72.5; SB v BB limped 2 / 99. Assumption: "Assumed a 6.5bb pot: CO opens 2.5bb, BTN calls, blinds fold". Only used when neither `pot_bb` nor a usable history is given. A seat pair missing from the size table falls back to a generic pot per type (srp 5.5 / 97.5, 3bet 20 / 90, 4bet 45 / 77.5, limped 2 / 99) with "Assumed a 20bb pot (standard 3-bet pot at the flop)". |
| pot/stack from `actions` (`app/src/lib/history.ts`) | Used when `pot_bb` is null and some earlier street has action. Amounts → bb: `amount_unit` bb as is; else divide by `big_blind_size`; else infer the big blind from the preflop open as a 3x raise (open 15 → BB 5, with an assumption). Blinds: a blind posted by a player in the hand is inside their raise-to/call amount; blinds of seats not in the hand are dead money (BTN v BB +0.5bb, CO v BTN +1.5bb, SB v BB +0). An unmatched last bet on a finished street is assumed called. A bet/raise with no usable amount is sized half pot / 3x (with an assumption). Preflop with no amounts uses the standard flop pot for the pot type and seats (row above). Effective stack = starting stack − what each player put in. Prior streets with no action at all get "Assumed the flop checked through". A stated `pot_bb` skips the history (stack = start − half the pot). Exception: on a turn/river spot whose history has bets after the flop pot, a stated pot no bigger than the flop pot (+0.5bb) is the flop pot ("leads 4bb into 5.5bb"): the later bets are added ("Read your 5.5bb pot as the flop pot (bets came after it): 13.5bb at the start of the turn"). |
| pot/stack on turn/river with no usable history | Use the flop values. Add the assumption "checked through previous streets". |
| inconsistent amounts | `INVALID_STACKS`: non-positive amounts or blind size, a raise not bigger than the bet before it, or investments that leave no effective stack. |
| ranges (`app/src/lib/ranges/`) | Preflop ranges by position and pot type, 6-max cash, 100bb (`preflop-100bb.ts`), keyed by `(pot_type, IP position, OOP position)`. Each side is the range that reaches the flop on that line, as weighted hand classes (`AQs:0.45`): srp = open × flat; 3bet = 3-bet × opener's call; 4bet = opener's 4-bet × 3-bettor's call; limped = SB limp × BB check. Covers all 15 heads-up seat pairs for srp, 3bet and 4bet plus SB v BB limped (46 pairs). Preflop sizes behind them are the size table in the pot/stack row (open 2.5bb, SB 3.5bb; 3-bet 8–13bb; 4-bet 20–27.5bb); the preflop strategies assume a low-rake game, while the postflop solve uses no rake. Assumption: "Assumed standard 100bb ranges: BTN open vs BB call" (3bet: "BTN open, BB 3-bet, BTN call"; one side given: "Assumed OOP (BB) range from standard 100bb ranges: …"). Lines not in the table (cold 4-bets, squeezes, limped pots outside SB v BB) use a generic pair per pot type: "Assumed generic limped ranges (no standard 100bb ranges for BTN vs CO)". User ranges always win. |
| bet sizes, spot starts on the turn or river (both players, all streets) | bet `"33%, 75%"`, raise `"3x"`. On the river, add `"a"` to the bets. The assumption names only the streets the solver plays, e.g. "Bet sizes the solver considers on the turn and river: …". |
| bet sizes, spot starts on the flop (`DEFAULTS.flopTree`) | A tree built around the **preflop raiser** (`preflopAggressor`: the opener in srp and 4-bet pots, the 3-bettor in 3-bet pots, none in limped pots; sent as `preflop_aggressor`). Flop: the raiser bets `"33%, 75%"`; the caller gets a `"3x"` raise (a check-raise when OOP), an OOP caller doesn't lead (OOP flop bet `""`), an IP caller may bet `"33%"` when checked to. Limped: both bet, OOP can check-raise 3x. Turn and river: `"75%"` bets, no raises, `donk: ""` (no leads into the previous street's bettor). Sent as two trees: `bet_sizes` with c-bets 33%/75% and `bet_size_fallbacks` = the same with 33% only; the solver solves the first one estimated within its time budget (§7 "Tree budget"). Assumption, e.g. "Flop tree: BTN (preflop raiser) bets 33% or 75%, BB can check-raise 3x and doesn't lead; turn and river: 75% bets, no raises or leads into the last bettor" (OOP raiser: "…, BTN can raise 3x or bet 33% when checked to; …"; limped: "Flop tree: both players bet 33% or 75%, SB can check-raise 3x; …"). After the solve, `treeChoiceAssumptions` swaps it for the tree the solver picked (fallback: "… bets 33%, …"; auto-simplified: "…, no raises; … (simplified to keep the solve fast)"). The full tree above needs ~20GB on a flop. Measured on an M1 (wide default ranges, to 0.5%): BTN v BB Td9d6h 33%/75% tree 647MB / ~8s, Ks7d2c (rainbow, the worst case) falls back to 33% 647MB / ~8-11s, CO v BTN Qs8h5c 33%/75% 586MB / ~11s, BB-3bet v BTN Td9d6h 33%/75% 352MB / ~7s; Fly is ~2x slower. A flop spot where the user gave a size uses it on every street (rest: flop 33%, turn/river 75%, no raises), with no fallbacks. |
| donk sizes | Turn/river spots: none sent (OOP may lead with its bet sizes). Default flop trees: `""` on the turn and river (no leads). |
| thresholds | add_allin 1.5, force_allin 0.15, merging 0.1, rake 0 |
| iterations / target | max 1000 iterations. Target exploitability is 0.5% of the starting pot. |
| hero_hand not in hero's range | Append it to the range string at weight 1 and add an assumption saying so. |
| action on the current street (`app/src/lib/street.ts`) | The `actions` on the decision street become §7 `street_actions`, always ending with villain's action. Trailing hero entries are the question ("should I call?") and are dropped ("Treated your call on the flop as the decision you're asking about"). A missing first check is filled in ("Assumed villain checked first on the flop"). Amounts → bb as in history; `pot_pct` sizes a bet off the pot at the start of the street, a raise as call + that share of the pot after the call; no size → half pot / 3x with an assumption; a bet of the whole stack is all-in. A call, fold, out-of-turn action, or two checks means there's no decision to walk to: "Couldn't use the flop action (…): strategy starts at the beginning of the flop". Solver result → "Strategy shown at your decision after the flop action (villain bet 4.13bb)", "Added to the solver's flop sizes: villain's 4.13bb bet for villain", a size the tree couldn't hit → "… was solved as …", a villain line the solver almost never plays → "… villain's whole range was assumed to take it", a walk that failed → "Couldn't play the flop action in the solver's tree (…): strategy starts at the beginning of the flop". |
| known villain hand (`app/src/lib/villain.ts`, `request.ts`) | Villain's range string becomes that hand (`"7c2d"`, `"72o"`, `"72s,72o"` for `"72"`), `villain_hand` is sent (§7), the earlier-street `line` is not sent (nothing to narrow; its "No earlier action…"-type assumptions are dropped), and the assumption "Villain's hand known: 72o — strategy is exact against that hand." is added. Unreadable → "Ignored villain hand …". No combo left after the board and hero's cards → `INVALID_BOARD`. |
| ranges on a turn/river spot with earlier postflop action (`app/src/lib/line.ts`) | Send the line to the solver (§7 `line`, `flop_pot`, `flop_stack`), which narrows both ranges with a simplified flop solve before solving the current street. History actors map to OOP/IP, amounts to chips (bet size; raise-to total for a raise). Implied calls and an implied check behind are filled in; an earlier street with no action given is sent as two checks. The flop pot/stack are the current pot/stack minus what each player put in after the flop (works for a stated pot too). Assumptions: narrowed → "Ranges narrowed by a simplified flop solve of your line (villain checked, you bet 25bb, villain called on the flop). Flop model: you bet 33%/75%, villain doesn't lead, no raises; your 25bb bet added for you. Later streets: one bet size, no raises or leads into the last bettor." (one "<Street> model" sentence per line street, from `line_bets`/`line_raises`, `line_aggressor` and the `added` sizes; without an IP raiser: "Flop model: both players bet 33%/75%, no raises; …"). The request carries `preflop_aggressor` (as for flop trees) so stage 1 can drop the OOP caller's flop leads; a size the tree couldn't hit exactly → "Your 25bb flop bet was solved as …"; skipped → "Ranges not narrowed (<solver reason>): full preflop ranges used"; a blended player (§7 "Rare lines") → "Villain's line is unusual at equilibrium (~2% of his range) — his range is a rough estimate blended toward his starting range." (or "Your line …your range…"; "under 1%" below 1%), and the narrowed-ranges panel shows "Unusual line (~2% of range): rough estimate, blended toward the starting range" under that player. Not sent when the user gave ranges ("Ranges not narrowed by the earlier betting (you gave the ranges)") or the stated pot is smaller than the earlier bets. No postflop action before the current street → "No earlier action given: ranges are full preflop ranges." Flop spots are unchanged. |

**Units:** the solver takes integer chips. Use **1bb = 100 chips** (`round(bb * 100)`), and convert back when displaying.

**OOP/IP:** postflop action order is SB, BB, UTG, HJ, CO, BTN. Whichever player comes earlier in that list is OOP. Hero can be either seat.

## 6. Validation and every "can't solve" path

The app checks first (cheap, before any HTTP call), and the solver re-checks authoritatively. All failures share one shape:

```json
{ "status": "cant_solve", "reason": "PREFLOP", "message": "Can't solve this: preflop spots aren't supported yet." }
```

| reason | Detected by | Trigger |
|---|---|---|
| `NOT_POKER` | app | `is_poker_spot == false` |
| `PREFLOP` | app | `street == "preflop"`, or no board given |
| `MULTIWAY` | app | `num_players` present and not 2. The solver is heads-up only. |
| `INVALID_BOARD` | app + solver | Board not 3-5 valid cards, duplicate cards, card count doesn't match street, `hero_hand` overlaps the board, or `villain_hand` has no combo left after the board and hero's cards |
| `INVALID_RANGE` | solver | Range fails to parse, or is empty after board blockers ("Valid card assignment does not exist", "OOP/IP range is empty") |
| `INVALID_BET_SIZES` | solver | `BetSizeOptions::try_from` / `ActionTree::new` rejects the config |
| `INVALID_STACKS` | app | pot ≤ 0 or stack ≤ 0, or inconsistent `actions` amounts (§5) |
| `TREE_TOO_LARGE` | solver | `memory_usage()` is over `MAX_MEMORY_MB` even compressed, or "Too many nodes" |
| `TIMEOUT` | solver | Wall clock passed `SOLVE_TIMEOUT_SECS` before the target was reached (see §8) |
| `SOLVER_BUSY` | solver | The solver queue is full (`QUEUE_MAX_WAITING` already waiting), or the request waited `QUEUE_MAX_WAIT_SECS` without starting (see §8) |
| `RATE_LIMITED` | solver `/admit` | Per-IP (100/hour) or global (10000/day) limit reached; checked before the LLM call |
| `LLM_UNAVAILABLE` | app | Provider error or timeout |
| `SOLVER_UNAVAILABLE` / `INTERNAL` | app / solver | Network error or an unexpected panic |

The UI shows `message`. `reason` is for logs and tests. Don't retry by asking the LLM to "fix" the input.

## 7. Solver HTTP contract

`POST /solve`, request (the app has already applied defaults, so every field is present):

```json
{
  "board": "Td9d6h",                 // 3-5 cards; the count sets BoardState Flop/Turn/River
  "oop_range": "22-JJ,A2s-AJs,...",
  "ip_range": "22+,A2s+,...",
  "starting_pot": 550,               // chips (1bb = 100)
  "effective_stack": 9750,
  "bet_sizes": {                     // both players, unless "oop"/"ip" override bet/raise
    "flop":  {"bet": "33%, 75%", "raise": "3x"},
    "turn":  {"bet": "33%, 75%", "raise": "3x"},
    "river": {"bet": "33%, 75%, a", "raise": "3x"}
    // e.g. {"bet": "33%", "raise": "", "oop": {"bet": "", "raise": "3x"}}: IP bets 33%, OOP
    // only checks and check-raises 3x. Turn/river also take "donk": OOP's lead sizes after
    // calling the previous street's bet ("" = no leads; absent = its bet sizes).
  },
  // Optional: simpler trees to fall back to, in order (same shape as bet_sizes). §7 "Tree budget".
  "bet_size_fallbacks": [],
  // Optional: the preflop raiser's seat ("oop" | "ip"). Line narrowing uses it.
  "preflop_aggressor": "ip",
  "hero": { "player": "ip", "hand": "AhKh" },   // hero.hand nullable
  "max_iterations": 1000,
  "target_exploitability_pct": 0.5,  // percent of starting_pot
  // Optional, turn/river spots only: the betting on earlier postflop streets, in order.
  // amount_chips = bet size for "bet", raise-to total for the street for "raise", else null.
  "line": [
    {"street": "flop", "player": "oop", "action": "check", "amount_chips": null},
    {"street": "flop", "player": "ip",  "action": "bet",   "amount_chips": 2500},
    {"street": "flop", "player": "oop", "action": "call",  "amount_chips": null}
  ],
  "flop_pot": 2450,                  // chips at the start of the flop (with line)
  "flop_stack": 8800,
  // Optional: action on the current street before hero's decision, same entry shape
  // (action check|bet|raise|allin; amount_chips null for check/allin). Ends with villain.
  "street_actions": [{"street": "turn", "player": "oop", "action": "bet", "amount_chips": 600}],
  // Optional: villain's known hand, exact "7c2d" or a class "72o" | "72s" | "77" | "72".
  "villain_hand": null
}
```

**Current-street actions (`street_actions`, `solver/src/street.rs`).** Checked in `config::prepare`: entries on the current street, in turn, no call or fold, two checks not allowed, ending with hero to act. Each bet / raise / all-in is added to the acting player's options for the current street only (a bet as the shortest exact `N%`, a raise as the shortest exact `Nx`, an all-in as `a`), unless a default already gives that amount; close sizes are not merged (`merging_threshold` 0 when anything was added). When hero faces a bet that isn't all-in, hero gets a 3x raise (only if the street has no raise sizes, e.g. flop spots) and an all-in raise, added with `ActionTree::add_line` at the decision node only: adding them to the street's options gave every flop lead branch a raise subtree and pushed a BTN-vs-BB lead spot to 2 GB raw / 1.04 GB compressed. Before the solve the game walks the actions (bets/raises matched by closest amount within 10%, else the all-in the tree turned them into) and locks hero's exact hand into hero's own actions so it reaches the decision with weight. After `finalize` it walks again and reports: `nodes` = villain's last decision, then hero's decision (`line` = action names, e.g. `["Check","Bet","Raise"]`); `hero_hand` at hero's node; `players` (equity/EV) at hero's node; `street_line.villain_range` (villain's classes there, `combos_before` at the street start). If villain's range reaches the node with under 1 weighted combo (the solver never plays that line), the street is re-solved with villain's whole range locked into the actions (`villain_rare`, `villain_locked`), when at least 25% of the timeout is left. With `villain_hand`, villain's range is exactly those combos (board/hero blockers removed; none left → `INVALID_BOARD`), its street actions are locked for every combo from the start, `line` is skipped ("villain's hand is known"), and villain's (locked) node is left out of `nodes`. Any problem (bad entry, out of turn, the walk not matching) falls back to the usual start-of-street nodes with `street_line.matched: false` and a `reason`. All-in-and-call is a terminal: hero facing a shove gets Fold / Call with exact showdown EVs.

**Tree budget (`solve::pick_tree`).** Stage 2 picks its tree from a list, richest first: `bet_sizes`, then `bet_size_fallbacks`, then two auto-simplified trees made from the last of those: all raises dropped (`"no_raises"`), then also one bet size per street and player (the first listed that isn't all-in; `"one_size"`); duplicates are skipped. Each gets the `street_actions` sizes and hero's raise lines. For each in turn the solver runs the size pre-check, builds the action tree and node arena (~0.1 s per flop tree) and reads `memory_usage()`: a tree over `MAX_MEMORY_MB` even compressed is skipped; otherwise the estimated solve time is `raw MB × TREE_MS_PER_MB / 1000` (default 40 ms/MB, calibrated for Fly), and the first tree within `TREE_BUDGET_SECS` (default 30) is solved. If none is, the cheapest one that fits memory is solved (`over_budget: true`); if none fits memory, `TREE_TOO_LARGE`. Measured on an M1 (wide default ranges, no-donk flop trees, to 0.5%): 13–25 ms per raw MB (~16 typical; more raises cost more per MB, compressed storage about the same per raw MB), 60–80 iterations; Fly's shared-cpu-4x is ~2x slower, so 40 ms/MB keeps chosen trees at ≤ ~750 MB raw and ≤ ~30 s there. The response's `tree` says what was solved: `index` into that list, `given` (1 + fallbacks), `auto`, the tree's `bet_sizes`, `estimated_secs`, `raw_mb`, `over_budget`. Examples: BTN v BB Ks7d2c default flop tree → the 33% fallback (647 MB, est. 26 s, 8–11 s on an M1); a 75% BB lead on Ks7d2c → `no_raises` (855 MB, est. 34 s, `over_budget`, 13 s on an M1; was 29 s at 784 MB compressed with the old 50% tree); limped SB v BB Qs8h5c → `no_raises` (892 MB, 11 s on an M1).

**Line solves (two stages, one request).** With `line`, the request still takes one queue slot and one `SOLVE_TIMEOUT_SECS` budget. Stage 1 builds a game from the **flop** (flop cards, `flop_pot`, `flop_stack`, the request's ranges). On each street the line covers, both players get bets of 33% and 75% and no raises (a default 3x raise made a wide single-raised-pot turn spot's stage-1 game 1.4 GB compressed, over the 1 GB cap), except that with `preflop_aggressor: "ip"` OOP gets no default flop bets (no leads into the raiser; `narrowing.line_aggressor` echoes it). Measured on a wide BTN-vs-BB Ks7d2c4h turn spot (flop check / 33% bet / call): with OOP flop leads and no raises the solve had the BB lead the flop as a stand-in for the missing check-raise, so only 26–36% of its range check-called (real BB strategies almost never lead there) and stage 1 took ~22–28 s on an M1 (~45–55 s on Fly); without leads 76% check-call, converged at the 1% target (same ranges at 0.3%), ~5–7 s. A 3x check-raise for the caller instead was more faithful (45% check-call) but took ~14–20 s, wasn't converged at 1% (IP's range 212 vs 296 combos at 0.3%), and pushed a river spot's stage 1 to 2.3 GB raw / 1.2 GB compressed; each bet or raise the line used is added only to the acting player's options on that street (a bet as the shortest `N%` of the pot that reproduces the chip amount, a raise as the shortest `Nx` of the bet it raises), unless a default already gives the same chip amount. Close sizes are not merged in stage 1 (`merging_threshold` 0), so the line's exact size stays next to a nearby default. Streets after the line (the current street and later) get one size, no raises and no donk bets (75%; OOP checks to the previous street's bettor). They only give the line's streets continuation values, and the leads were ~30% of the tree. It solves to 1% of the flop pot (at most 300 iterations and half the timeout), then walks the line (actions matched by kind, bets/raises by closest amount, which is the exact line size; then the dealt turn and river cards) to the first decision of the current street and reads both players' range weights there (`weights(p)`: starting weight times the probability of taking the line). Each player's weights are scaled so the likeliest live combo is 1 (stage 2 only needs relative weights, and a line the flop solve rarely takes would otherwise round to nothing), rounded to 3 decimals, dropped below 0.005, written with the crate's `Range` syntax (board-blocked combos get their class's weight so uniform classes stay one token), and parsed back. Summary combo counts and class weights are scaled back to absolute (share of the starting combos that take the line). Hero's exact hand is kept at relative weight ≥ 0.01. Stage 2 is the normal solve with those ranges.

**Rare lines.** Equilibrium narrowing is brittle when a player's line is one the flop solve almost never takes: the narrowed range collapses to a fraction of a combo picked by fine solver detail, and small model changes flip the answer (measured on the user's 3-bet-pot spot: hero 2h2s's turn strategy went bet 99% / check 99% / bet 97.5% across three near-identical stage-1 configs). Real players taking rare lines have wider, messier ranges, and the goal is answers that are roughly right and stable. So for each player, before scaling, stage 1 computes the **line probability** `p = Σ reach / Σ prior` over live combos (absolute reach = starting weight × the player's own action frequencies along the line, i.e. the share of the starting range that takes the line). If `p ≥ RARE_LINE_THRESHOLD` (env, default 0.05; 0 turns this off) the narrowed range is used as is. Below it, the range is a blend: `w_i = α·reach_i + (1 − α)·R·feasible_i / Σ feasible` with `feasible_i = min(prior_i, reach_i / p)`, `R = Σ reach`, `α = max(p / threshold, 0.3)`. `feasible` is the line-feasible part of the starting range: a combo counts at its full starting weight if it takes the line at least as often as the range as a whole, proportionally less if rarer, and not at all if it never does, so the blend flattens the few combos the equilibrium concentrates on into every hand that plausibly fits the line while keeping hands that never take it out. α is 1 at the threshold (no jump) and never below 0.3, so the range always leans toward line-consistent hands. The total stays `R` and no combo exceeds its starting weight, so summary counts stay absolute (`combos_after` = `p` × `combos_before`). Board blockers are dropped as before and hero's exact hand keeps its floor. Each player's `narrowing.ranges.<p>` reports `line_probability`, `blended` and `alpha`; `narrowing.rare_line_threshold` the threshold used. Measured on the user's spot (hero 2h2s's turn strategy and its check−bet EV gap across the default config, a 3x flop raise, and 33%/75% on the turn in stage 1): with the older 124/203-combo ranges, check 99% / check 86% / bet 97.5% before, check 55% / 55% / 59% after (gaps ≤ 0.2bb in a 74.5bb pot); with the current ranges, check 78% / 100% / 100% before (gaps 0.8 / 3.4 / 2.3bb), bet 90% / check 100% / check 100% after (gaps −0.3 / 1.1 / 2.4bb). The hand is close to indifferent, so frequencies can still tip; ranges and equity agree more closely. A common line (wide BTN-vs-BB pot, 33% c-bet and call: p = 0.32 / 0.44) is not blended and unchanged. The current-street walk (`street_actions`) needs no blend: its villain range at hero's decision is only reported (no later solve uses it), and a villain reaching it with under 1 combo already triggers the locked re-solve. The tree-size pre-check and memory check run for both stages. Narrowing never fails the request: a line that doesn't fit (fold or all-in in the line, action out of turn or on the current street, a street not closed by a call or check behind, missing turn action on a river spot, amounts that don't add up to `starting_pot`/`effective_stack` within 1%, an entry that can't be read, a stage-1 tree over the memory limit, stage-1 time out, a crate panic, an empty narrowed range) skips stage 1, solves from the request's ranges, and says why in `narrowing.reason`.

Success `200`:

```json
{
  "status": "ok",
  "exploitability_pct": 0.42,        // percent of pot
  "iterations": 340,
  "solve_ms": 18400,
  "memory_mb": 1210,
  "compressed": false,
  "players": {
    "oop": { "equity": 0.47, "ev": 252.1 },   // range-average, chips
    "ip":  { "equity": 0.53, "ev": 297.9 }
  },
  "nodes": [                          // root (OOP to act) + IP facing a check
    { "line": [], "player": "oop",
      "actions": [ { "action": "Check", "amount": 0, "frequency": 0.71,
                     "top_hands": ["KQo","A5s"],               // class names of top_classes
                     "top_classes": [ { "hand": "KQo", "frequency": 0.72 },
                                      { "hand": "A5s", "frequency": 1.0 } ] }, ... ] },
    { "line": ["Check"], "player": "ip", "actions": [ ... ] }
  ],
  "hero_hand": { "hand": "AhKh", "node": 1, "equity": 0.61, "ev": 410.2,
                 // ev: hero hand's EV per action (expected_values_detail), chips; fold = 0
                 "actions": [ {"action": "Bet", "amount": 182, "frequency": 0.64, "ev": 415.0}, ... ] },
  // every node also has "pot" (chips in the middle, current-street bets included) and "to_call"
  "street_line": {                    // only when the request had street_actions
    "matched": true, "reason": null,  // false + reason: start-of-street nodes instead
    "sizes": [ { "street": "flop", "player": "oop", "action": "allin", "requested": 9750,
                 "used": 9750, "size": "a", "added": true } ],
    "villain_locked": true,           // villain's whole range forced into the line
    "villain_rare": false,            // ...because the solver's villain never played it
    "villain_range": { "combos_before": 12.0, "combos_after": 12.0,
                       "classes": [ { "hand": "72o", "combos": 12.0, "weight": 1.0 } ] }
  },
  "tree": { "index": 1, "given": 2,   // which of [bet_sizes, ...fallbacks, ...auto] was solved
            "auto": null,             // "no_raises" | "one_size" for auto-simplified trees
            "bet_sizes": { ... },     // its sizes (street_actions sizes come on top)
            "estimated_secs": 25.9, "raw_mb": 647.0, "over_budget": false },
  "narrowing": {                      // only when the request had a line
    "narrowed": true,
    "reason": null,                   // why not, when narrowed is false
    "oop_range": "QsQd,QsQc:0.971,...", // weighted ranges stage 2 solved with (likeliest combo = 1)
    "ip_range": "...",
    "ranges": { "oop": { "combos_before": 159.0, "combos_after": 3.97,   // absolute
                         "classes": [ { "hand": "QQ", "combos": 0.065, "weight": 0.0216 }, ... ],
                         "line_probability": 0.025, // share of the starting range taking the line
                         "blended": true,           // p < rare_line_threshold: blended toward the start range
                         "alpha": 0.5 },            // share of the blend from the narrowed range
                "ip": { ... } },
    "sizes": [ { "street": "flop", "player": "ip", "action": "bet",
                 "requested": 2500, "used": 2500, "size": "102.04%",
                 "added": true } ],   // false: equals a default, nothing added
    "line_bets": "33%, 75%",          // both players, on the line's streets
    "line_raises": null,              // none by default
    "line_aggressor": "ip",           // request's preflop_aggressor; "ip": OOP had no flop leads
    "hero_weight": 0.009, "hero_floored": false,
    "iterations": 80, "exploitability_pct": 0.65, "memory_mb": 397.9,
    "solve_ms": 11110,                // stage 1; the top-level solve_ms covers both
    "rare_line_threshold": 0.05       // RARE_LINE_THRESHOLD used (0 = no blending)
  }
}
```

Errors return `422` (input problems), `503` (`SOLVER_BUSY`), or `504` (`TIMEOUT`), using the §6 body shape. Input is validated before the request joins the queue, so bad input gets its `422` right away even when the solver is busy. Keep the payload small: 2 nodes, at most 6 `top_classes` per action, and no per-hand arrays.

**Streaming (`Accept: application/x-ndjson`).** Same request. Errors that happen before the request is queued (malformed body, validation, queue full, auth) still come back as plain JSON with the status codes above. Otherwise the response is `200` with `Content-Type: application/x-ndjson`, one JSON object per line:

```
{"type":"queued","position":3}     // place in line, 1 = next; sent on joining and on every move
{"type":"queued","position":2}
{"type":"queued","position":1}
{"type":"narrowing"}               // line solves only: stage 1 (flop solve of the line) is running
{"type":"solving"}                 // holding the solve slot
{"type":"result", ...200 body}     // final line on success (the body above plus "type")
{"type":"error",  ...§6 body}      // final line on failure, e.g. SOLVER_BUSY "queue timed out", TIMEOUT
```

A request that finds the solver idle skips straight to `solving` (or `narrowing` for a line solve, followed by `solving` when stage 2 starts; a line skipped during validation goes straight to `solving`). While queued or solving, the current status line repeats every 5 s as a heartbeat (keeps proxies from closing an idle connection, and lets the solver notice a client that hung up). Readers should treat repeats as no-ops and skip blank lines. Exactly one `result` or `error` line ends the stream.

`/api/solve` speaks the same protocol to the browser when sent `Accept: application/x-ndjson`: it relays the solver's `queued`/`solving` lines and ends with `{"type":"result", ...SolveApiResponse}` or `{"type":"error", ...§6 body}` (app messages). It opens with one blank 1 KB padding line, because WebKit holds back the first ~1 KB of a stream. Bad input and `/admit` refusals stay plain JSON (`400`/`429`/`503`). Without the header, `/api/solve` returns one JSON body as before. If the browser disconnects, the app aborts its solver request, which frees the queue place.

`top_classes` groups the acting player's combos into hand classes (`KK` pair, `KQs` suited, `KQo` offsuit), skipping zero-weight combos (board-blocked or out of range). Classes are ordered by frequency (compared at 1% resolution), ties broken by the range weight they send into the action (sum of weight × frequency over their combos). Each class's `frequency` is the weight-averaged probability that its live combos take the action. `top_hands` lists the same class names as plain strings, for older clients.

## 8. Rust implementation notes (real `postflop-solver` API)

Everything below is re-exported from the crate root (`use postflop_solver::*;`). See `examples/basic.rs` in the cargo git checkout (`~/.cargo/git/checkouts/postflop-solver-*/`).

**Parsing**
- `flop_from_str("Td9d6h") -> Result<[Card;3], String>` and `card_from_str("Qc") -> Result<Card, String>`. Split the board into flop, turn, and river, using `NOT_DEALT` for streets that haven't been dealt.
- Card ids are `u8` with `id = 4*rank + suit` (rank 2=0 … A=12; suits c,d,h,s = 0..3).
- Ranges: `"...".parse::<Range>()`. The syntax is comma-separated groups with optional `:weight`, using singletons (`AA`, `AKs`, `AKo`, `AsAh`), plus ranges (`TT+`, `ATs+`), and dash ranges (`QQ-88`, `A9s-A6s`).
- Bet sizes: `BetSizeOptions::try_from(("33%, 75%", "3x"))`. Tokens are `N%` (pot), `Nx` (previous bet, raises only), `Nc` (constant chips), `e`/`Xe`/`XeY%` (geometric), and `a` (all-in). Donk sizes use `DonkSizeOptions::try_from("50%")`.

**Building**
```rust
let card_config = CardConfig { range: [oop, ip], flop, turn, river };
let tree_config = TreeConfig {
    initial_state: BoardState::Flop /* must match the dealt cards */,
    starting_pot, effective_stack, rake_rate: 0.0, rake_cap: 0.0,
    flop_bet_sizes: [s.clone(), s.clone()], turn_bet_sizes: [...], river_bet_sizes: [...],
    turn_donk_sizes: None, river_donk_sizes: None,
    add_allin_threshold: 1.5, force_allin_threshold: 0.15, merging_threshold: 0.1,
};
let tree = ActionTree::new(tree_config)?;            // Err(String) on a bad config
let mut game = PostFlopGame::with_config(card_config, tree)?;  // Err(String): duplicates, empty ranges, ...
```
Map the `Err(String)` messages to the §6 reasons by substring, with `INTERNAL` as the fallback.

**Memory:** first, before `ActionTree::new`, estimate the action tree plus node arena from the config and return `TREE_TOO_LARGE` if that already passes `MAX_MEMORY_MB`, because `with_config` allocates the arena (64 B per node per runout) up front (`solver/src/tree_size.rs`). Then `let (raw, compressed) = game.memory_usage();` (bytes) **before** allocating. If `raw` fits within `MAX_MEMORY_MB`, call `allocate_memory(false)`. Otherwise, if `compressed` fits, call `allocate_memory(true)`. If neither fits, return `TREE_TOO_LARGE`.

**Solving:** don't call `solve()` for production use. It panics if the game isn't ready, and it can't be cancelled. Write the loop yourself so you can enforce the timeout:
```rust
for i in 0..max_iters {
    solve_step(&game, i);
    if (i + 1) % 10 == 0 {
        let e = compute_exploitability(&game);
        if e <= target || deadline_passed() { break; }
    }
}
finalize(&mut game);
```
If the deadline passed and `e > target * 3`, return `TIMEOUT`. Otherwise return the result with the exploitability it actually reached; the UI flags it if it's above target.

**Concurrency:** run the whole build-and-solve inside `tokio::task::spawn_blocking`, because the solve is CPU-bound and rayon already uses every core. Allow **one solve at a time**, behind a bounded FIFO queue (`solver/src/queue.rs`): up to `QUEUE_MAX_WAITING` (5) requests wait in arrival order, each for at most `QUEUE_MAX_WAIT_SECS` (120). A full queue returns `SOLVER_BUSY` immediately; a wait that runs out returns `SOLVER_BUSY` with "queue timed out". The queue is an explicit `VecDeque` of tickets plus a `watch` channel, so a waiter's position is exact and can be streamed. (`tokio::sync::Semaphore` is FIFO too, but it can't report positions, and a waiter only joins its queue on first poll.) Dropping a ticket (client disconnect, timeout) leaves the line. The slot's permit moves into the blocking task, so it's held until the solve really ends, even if the client is gone. Catch panics (`std::panic::catch_unwind`, or check the `JoinError` from the join handle) and return `INTERNAL`.

**Reading results** (after `finalize`):
- Call `game.cache_normalized_weights()` once at the root.
- For each player p: `equity(p)` and `expected_values(p)` are per-hand `Vec<f32>`. Average them with `compute_average(&v, game.normalized_weights(p))`.
- `available_actions()` returns `Vec<Action>` (`Fold`, `Check`, `Call`, `Bet(i32)`, `Raise(i32)`, `AllIn(i32)`).
- `strategy()` is laid out as `[action_idx * n_hands + hand_idx]`, where `n_hands = game.private_cards(current_player).len()`.
- The overall action frequency is the strategy weighted by `normalized_weights(player)`. For `top_classes`, group `private_cards(p)` into classes by rank and suitedness (card id = 4*rank + suit), sum `weight * freq` and `weight` per class, sort by the ratio (rounded to 1%) then by the first sum, and report the ratio as the class frequency. The hero's hand string comes from `holes_to_strings(game.private_cards(p))`.
- Move through the tree with `play(action_idx)` and `back_to_root()`. To read the node where IP faces a check, play the index of `Action::Check` at the root. Look up hero's hand index in `private_cards(hero)` by string.

## 9. UI (single page, `app/src/app/page.tsx`)

- A textarea with a submit button and 2-3 clickable example prompts. Show a loading state with a hint like "solving can take up to ~90s".
- **Spot card:** board (rendered cards), positions, pot and stack in bb, ranges (collapsed), and bet sizes.
- **Assumptions:** a bulleted list, highlighted so users see what was guessed.
- **Results:** a stacked bar of action frequencies for each node, labeled in bb and % of pot, the top hand classes per action with how often each takes it (e.g. "KK 100%"), equity and EV per player, the hero-hand callout if present, and exploitability plus solve time in small text.
- **Hero-hand callout:** titled by the decision ("YOUR HAND A♥K♥ — FACING BB ALL-IN 97.5bb", "— AFTER BB CHECKS", "— ACTING FIRST"), with the street action below it. Each action row shows frequency and, right-aligned, the hand's EV ("CALL 97.5bb 100% +32.32bb"); the best-EV action is inverted (EVs within 0.1bb are a tie, won by the more frequent action).

  With current-street action, a "Villain range at your decision" section lists villain's classes there, and a known villain hand appears in the spot card.
- **Can't-solve state:** a neutral panel showing `message` and the original input, with no strategy shown.
- No auth, history, or persistence.

## 10. Milestones (do them in order, each with acceptance criteria)

1. **Solver core.** Implement `/solve` per §7-8.
   *Accept:* `curl` with a river spot (board `Td9d6hQc2s`, srp ranges) returns `200` in under 5s in release mode, frequencies at each node sum to 1 ± 1e-3, and a duplicate-card board returns `422 INVALID_BOARD`.
2. **Solver guards.** Memory check, timeout, busy semaphore, and panic catch.
   *Accept:* `MAX_MEMORY_MB=1` returns `TREE_TOO_LARGE`, `SOLVE_TIMEOUT_SECS=1` on a flop spot returns `TIMEOUT` or a partial result, and two concurrent requests make one of them return `503`.
3. **Extraction.** schema.ts, prompts.ts, llm.ts.
   *Accept:* a small script or test runs 10 fixture prompts and prints parsed objects. Unstated fields come back `null`. Switching `LLM_MODEL` to a second provider works after only an install and one registry line.
4. **Defaults + validation.** defaults.ts and validate.ts as pure functions.
   *Accept:* unit tests (vitest) cover every §5 row and every app-side §6 reason.
5. **Wire-up.** `/api/solve` route plus solver.ts.
   *Accept:* end to end, the example prompt in §1 returns a strategy and an assumptions list, "what's the capital of France" returns `NOT_POKER`, and a 3-way pot returns `MULTIWAY`.
6. **UI** per §9.
   *Accept:* all three states (loading, ok, can't-solve) render and the layout works at phone width.
7. **Mid-street lines.** Done: current-street `actions` → `street_actions` (§5, §7), plus known villain hands.

## 11. Testing

- **Rust:** unit tests for board splitting and error mapping, plus one integration test on a tiny river spot. Mark slow flop tests `#[ignore]`.
- **App:** vitest for defaults, validation, OOP/IP ordering, and bb↔chip conversion. Mock the solver client in route tests.
- **LLM evals:** `app/evals/fixtures.json` holds pairs of (prompt, expected extracted fields). Run them only when `RUN_LLM_EVALS=1`, since they cost money. Include slang ("button", "3-bet pot", "Ten-nine-six two diamonds"), missing info, multiway, preflop, and non-poker cases.

## 12. Non-goals (for now)

LLM fallback reasoning for unsolvable spots, preflop solving, multiway spots, rake, node locking, saving or loading solves, auth, and persistence. Narrowing ranges by preflop action beyond the pot type.

## 13. Licensing and upstream status

`postflop-solver` is **AGPL-3.0**. Running it behind a network service means the source of the combined work has to be offered to users. This repo is public, so link it from the UI footer. Upstream development is **suspended** (the author paused it in 2023), so expect no fixes. If you need patches, fork it and point the `Cargo.toml` git dependency at the fork. The dependency is currently pinned to commit `9d1509f` via `Cargo.lock`.
