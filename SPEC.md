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
| `pot_type` | `"limped"\|"srp"\|"3bet"\|"4bet"` | srp = single raised pot. |
| `pot_bb` | number | Pot size at the start of `street`, in bb. Null when the user's amounts can't be converted (no blind size); the pot then comes from `actions`. |
| `effective_stack_bb` | number | Effective stack at the start of `street`. |
| `starting_stack_bb` | number | Stack depth before the hand ("100bb deep"). |
| `amount_unit` | `"bb"\|"chips"` | Units of the `actions` amounts. `chips` covers chips, currency and bare numbers. |
| `big_blind_size` | number | Big blind in the same units as `actions` amounts (stakes "$1/$2" → 2). Only if stated. |
| `actions` | `[{street, actor: "hero"\|"villain", action, amount}]` | The betting line in order, up to and including the current street. `action` is `limp\|open\|raise\|3bet\|4bet\|call\|check\|bet\|fold`. `amount` is in the user's units, unconverted: raise-to total for open/raise/3bet/4bet, bet size for bet, null otherwise. A "raise" into a check is recorded as `bet`; implied calls (a street that continues) are recorded even when unstated. |
| `oop_range`, `ip_range` | string | PioSOLVER-style range string (see §6). Filled only if the user gave one. |
| `bet_sizes` | `{bet: string, raise: string}` | Filled only if the user named sizes, e.g. `"33%, 75%"`. |
| `notes` | string | Anything relevant that didn't fit, such as action already taken on the street. |

## 5. Defaults (`app/src/lib/defaults.ts`)

Every default that gets applied adds a readable line to `assumptions[]`, for example `"Assumed 100bb effective stacks (starting stack)"`. **All values are tunable.** Keep them in one exported constant.

| Missing | Default |
|---|---|
| positions | BTN (IP) vs BB (OOP). Hero takes the IP seat unless `actions` show hero acting first after the flop. |
| one position | The other comes from the pot type: srp → BB defends against the opener; 3bet → the opener calls the 3-bettor |
| pot_type | Inferred from preflop `actions` (open → srp, open + 3bet → 3bet, a 4bet → 4bet, limps only → limped), else srp |
| starting stack | 100bb |
| pot_bb / effective_stack_bb (flop) | srp: pot 5.5, stack 97.5. 3bet: pot 20, stack 90. 4bet: pot 45, stack 77.5. limped: pot 2, stack 99 |
| pot/stack from `actions` (`app/src/lib/history.ts`) | Used when `pot_bb` is null and some earlier street has action. Amounts → bb: `amount_unit` bb as is; else divide by `big_blind_size`; else infer the big blind from the preflop open as a 3x raise (open 15 → BB 5, with an assumption). Blinds: a blind posted by a player in the hand is inside their raise-to/call amount; blinds of seats not in the hand are dead money (BTN v BB +0.5bb, CO v BTN +1.5bb, SB v BB +0). An unmatched last bet on a finished street is assumed called. A bet/raise with no usable amount is sized half pot / 3x (with an assumption). Preflop with no amounts uses the standard flop pot for the pot type. Effective stack = starting stack − what each player put in. Prior streets with no action at all get "Assumed the flop checked through". A stated `pot_bb` skips the history (stack = start − half the pot). |
| pot/stack on turn/river with no usable history | Use the flop values. Add the assumption "checked through previous streets". |
| inconsistent amounts | `INVALID_STACKS`: non-positive amounts or blind size, a raise not bigger than the bet before it, or investments that leave no effective stack. |
| ranges | A lookup table keyed by `(pot_type, IP position, OOP position)`. Seed it with simple ranges for the common pairs (BTN v BB, CO v BB, SB v BB, BTN v SB 3bet, BB v BTN 3bet), plus a generic fallback per pot type. Rough srp BTN-v-BB seeds: IP `22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o` and OOP `22-JJ,A2s-AJs,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,75s+,64s+,53s+,A2o-AJo,K9o+,Q9o+,J9o+,T9o` |
| bet sizes, spot starts on the turn or river (both players, all streets) | bet `"33%, 75%"`, raise `"3x"`. On the river, add `"a"` to the bets. The assumption names only the streets the solver plays, e.g. "Bet sizes the solver considers on the turn and river: …". |
| bet sizes, spot starts on the flop | Simplified tree: flop bet `"50%"`, turn bet `"75%"`, river bet `"75%"`, no raises (raise `""`). Add the assumption "Simplified flop tree (one bet size, no raises) to keep solve time reasonable". The full tree above needs ~20GB on a flop and always returns `TREE_TOO_LARGE`; this one is ~520MB and solves in ~7s. |
| donk sizes | `null` (the solver's defaults) |
| thresholds | add_allin 1.5, force_allin 0.15, merging 0.1, rake 0 |
| iterations / target | max 1000 iterations. Target exploitability is 0.5% of the starting pot. |
| hero_hand not in hero's range | Append it to the range string at weight 1 and add an assumption saying so. |

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
| `INVALID_BOARD` | app + solver | Board not 3-5 valid cards, duplicate cards, card count doesn't match street, or `hero_hand` overlaps the board |
| `INVALID_RANGE` | solver | Range fails to parse, or is empty after board blockers ("Valid card assignment does not exist", "OOP/IP range is empty") |
| `INVALID_BET_SIZES` | solver | `BetSizeOptions::try_from` / `ActionTree::new` rejects the config |
| `INVALID_STACKS` | app | pot ≤ 0 or stack ≤ 0, or inconsistent `actions` amounts (§5) |
| `TREE_TOO_LARGE` | solver | `memory_usage()` is over `MAX_MEMORY_MB` even compressed, or "Too many nodes" |
| `TIMEOUT` | solver | Wall clock passed `SOLVE_TIMEOUT_SECS` before the target was reached (see §8) |
| `SOLVER_BUSY` | solver | Another solve is already running (see §8) |
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
  "bet_sizes": {                     // same for both players in the MVP
    "flop":  {"bet": "33%, 75%", "raise": "3x"},
    "turn":  {"bet": "33%, 75%", "raise": "3x"},
    "river": {"bet": "33%, 75%, a", "raise": "3x"}
  },
  "hero": { "player": "ip", "hand": "AhKh" },   // hero.hand nullable
  "max_iterations": 1000,
  "target_exploitability_pct": 0.5   // percent of starting_pot
}
```

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
                 "actions": [ {"action": "Bet", "amount": 182, "frequency": 0.64}, ... ] }
}
```

Errors return `422` (input problems), `503` (`SOLVER_BUSY`), or `504` (`TIMEOUT`), using the §6 body shape. Keep the payload small: 2 nodes, at most 6 `top_classes` per action, and no per-hand arrays.

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

**Concurrency:** run the whole build-and-solve inside `tokio::task::spawn_blocking`, because the solve is CPU-bound and rayon already uses every core. Allow **one solve at a time** using a `tokio::sync::Semaphore(1)` with `try_acquire`. If the permit isn't available, return `SOLVER_BUSY`. Catch panics (`std::panic::catch_unwind`, or check the `JoinError` from the join handle) and return `INTERNAL`.

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
7. *(Stretch)* **Mid-street lines.** If `notes` describes action already taken on the street (e.g. "OOP bets 75%"), play the closest matching action in the tree and report that node, adding an assumption about which size it was mapped to.

## 11. Testing

- **Rust:** unit tests for board splitting and error mapping, plus one integration test on a tiny river spot. Mark slow flop tests `#[ignore]`.
- **App:** vitest for defaults, validation, OOP/IP ordering, and bb↔chip conversion. Mock the solver client in route tests.
- **LLM evals:** `app/evals/fixtures.json` holds pairs of (prompt, expected extracted fields). Run them only when `RUN_LLM_EVALS=1`, since they cost money. Include slang ("button", "3-bet pot", "Ten-nine-six two diamonds"), missing info, multiway, preflop, and non-poker cases.

## 12. Non-goals (for now)

LLM fallback reasoning for unsolvable spots, preflop solving, multiway spots, rake, node locking, saving or loading solves, auth, persistence, deployment, and streaming progress.

## 13. Licensing and upstream status

`postflop-solver` is **AGPL-3.0**. Running it behind a network service means the source of the combined work has to be offered to users. This repo is public, so link it from the UI footer. Upstream development is **suspended** (the author paused it in 2023), so expect no fixes. If you need patches, fork it and point the `Cargo.toml` git dependency at the fork. The dependency is currently pinned to commit `9d1509f` via `Cargo.lock`.
