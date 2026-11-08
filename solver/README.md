# solver-service

Stateless HTTP wrapper around [`postflop-solver`](https://github.com/b-inary/postflop-solver) (AGPL-3.0). Contract: `../SPEC.md` §6-8.

## Run

```sh
cargo run --release          # always --release; debug is 10-50x slower
cargo test                   # fast tests (tiny river spot)
cargo test --release -- --ignored   # full srp river + slim flop spot
```

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | listen port |
| `MAX_MEMORY_MB` | 1024 | tree memory cap; falls back to compressed storage, else `TREE_TOO_LARGE` |
| `SOLVE_TIMEOUT_SECS` | 90 | wall clock per solve; past it, `TIMEOUT` if exploitability > 3x target, else partial result |
| `MAX_ITERATIONS` | 1000 | hard cap on `max_iterations` from the request |
| `SOLVER_API_KEY` | unset | when set, every route except `/health` needs header `x-solver-key` with this value (else `401 UNAUTHORIZED`) |
| `RATE_LIMIT_PER_IP_HOUR` | 100 | `POST /admit {"ip": "..."}` slots per IP per rolling hour |
| `RATE_LIMIT_GLOBAL_DAY` | 10000 | `/admit` slots across all IPs per rolling 24 hours |
| `QUEUE_MAX_WAITING` | 5 | `/solve` requests that may wait (FIFO) behind the running solve; beyond that `503 SOLVER_BUSY` right away. `0` = no queue |
| `QUEUE_MAX_WAIT_SECS` | 120 | longest wait in line before `503 SOLVER_BUSY` ("queue timed out") |
| `RARE_LINE_THRESHOLD` | 0.05 | line solves: a player whose stage-1 line takes less than this share of their starting range gets a range blended toward the starting range (0 = off) |
| `TREE_BUDGET_SECS` | 30 | stage-2 trees estimated slower than this are swapped for the next simpler one (see "Tree budget") |
| `TREE_MS_PER_MB` | 40 | solve-time estimate per MB of raw tree storage (Fly shared-cpu-4x; an M1 is ~16-20) |

One solve runs at a time; others queue (`src/queue.rs`). Input is validated before queueing. Send `Accept: application/x-ndjson` to get a streamed `200` with `{"type":"queued","position":N}` / `{"type":"solving"}` lines (repeated every 5 s as a heartbeat) and a final `{"type":"result",...}` or `{"type":"error",...}` line; see `../SPEC.md` §7. Without it, the response is one JSON body after the wait and solve. A client that disconnects while waiting gives up its place.

**Bet sizes per player, donks, tree budget.** Each street's `{"bet", "raise"}` may add `"oop"` / `"ip"` overrides (`{"bet": "33%", "raise": "", "oop": {"bet": "", "raise": "3x"}}`: IP bets 33%, OOP only checks and check-raises) and, on the turn/river, `"donk"` (OOP's lead sizes after calling the last street's bet; `""` = none). `bet_size_fallbacks` lists simpler trees. `src/solve.rs::pick_tree` solves the first of `[bet_sizes, ...bet_size_fallbacks, raises dropped, one bet size per street]` (duplicates skipped) that fits `MAX_MEMORY_MB` and whose estimate `raw MB × TREE_MS_PER_MB / 1000` fits `TREE_BUDGET_SECS`; else the cheapest that fits memory (`over_budget`). Each candidate is built to read its storage size (~0.1 s per flop tree). The response's `tree` reports `index`, `given`, `auto`, `bet_sizes`, `estimated_secs`, `raw_mb`, `over_budget`. Measured on an M1 (8 GB) with the app's wide default ranges, to 0.5% (Fly ~2x slower):

| Flop tree (turn/river 75%, no raises) | BTN v BB Td9d6h | BTN v BB Ks7d2c | CO v BTN Qs8h5c | BB-3bet v BTN Td9d6h |
|---|---|---|---|---|
| old default: 50% both, no raises, donks | 543 MB, 9-10 s | 912 MB, 21-25 s | 492 MB | 337 MB, 9.5 s |
| 33%+75% both, no raises, donks | 944 MB, 36 s | 1587 MB (comp), 41 s | 857 MB | 352 MB |
| 50% + 3x raises both, donks | 1635 MB | 2749 MB, over 1 GB comp | 885 MB | 391 MB |
| 33% + 3x both, river +all-in, donks | 1915 MB | 1642 MB comp, over | 1752 MB | 408 MB |
| 33%+75% + 3x both, donks | 2210 MB | 1895 MB comp, over | 2008 MB | 460 MB, 12.4 s |
| 33%, OOP check-raise 3x only, donks | 744 MB, 16-22 s | 1249 MB (comp), 30-32 s | 675 MB | 325 MB |
| same, no turn/river donks | 555 MB, 7 s | 931 MB, 13 s | 503 MB, 8 s | 298 MB |
| **raiser 33%, caller raise 3x, no OOP-caller lead, no donks** (fallback) | 386 MB, 5-7.5 s | 647 MB, 8-11 s | 350 MB, 5 s | 298 MB, 5 s |
| **raiser 33%+75%, same** (default) | 647 MB, 8 s | 1086 MB (comp), 25 s → fallback | 586 MB, 11 s | 352 MB, 7 s |
| raiser 33%, caller raise, + OOP turn check-raise | 619 MB, 15 s | 1040 MB (comp), 24 s | 563 MB, 14 s | 351 MB |

River all-in on every line roughly doubled iterations (63 s on Td9d6h). Turn/river donk bets cost ~30% of the tree and ~25% per MB. With street actions: a 75% BB lead on Ks7d2c → `no_raises` (855 MB, 13 s; was 29 s at 784 MB compressed with the old tree), on Td9d6h → the 33% fallback (725 MB, 14 s); BB check / BTN 33% on Ks7d2c with hero BB → fallback (647 MB, 10 s). Limped SB v BB Qs8h5c → `no_raises` (892 MB, 11 s). Turn spots with the default turn tree (33%/75% + 3x, river +all-in) stay small: wide BTN v BB Ks7d2c4h 84-92 MB, 3-7 s; 3-bet pot Td9d6h2c 11-13 MB, <0.4 s.

**Line solves.** A turn/river request may add `line` (earlier-street actions: `street`, `player` `oop`|`ip`, `action` `check`|`bet`|`call`|`raise`|`fold`|`allin`, `amount_chips`), `flop_pot` and `flop_stack`. Inside the same queue slot and timeout, `src/line.rs` solves a simplified flop game (on the line's streets both players bet 33%/75% with no raises, except no OOP flop bets when `preflop_aggressor` is `"ip"`, and each size the line used is added as an exact `N%` / `Nx` for the player who used it; one size, no raises and no donk bets after the line; no size merging; 1% target, ≤300 iterations, ≤half the timeout), walks the line to the current street, and hands both players' weighted ranges to the normal solve. The stream shows `{"type":"narrowing"}` then `{"type":"solving"}`. The response gains `narrowing` (`narrowed`, `reason`, the range strings, per-class summary, size mapping, stage-1 stats). Any problem with the line skips stage 1 with a reason instead of failing. Narrowed weights are scaled so each player's likeliest combo is 1 before rounding. A player whose line takes under `RARE_LINE_THRESHOLD` (5%) of their starting range gets a blended range instead of the collapsed equilibrium one: `α·narrowed + (1−α)·feasible` (normalized, total kept), `feasible_i = min(prior_i, reach_i / p)`, `α = max(p / threshold, 0.3)`; `narrowing.ranges.<p>` reports `line_probability`, `blended`, `alpha` (SPEC §7 "Rare lines"). Locally (M1, 8 GB, app default ranges): a wide BTN-vs-BB Ks7d2c4h turn spot with a flop check / 33% bet / call line narrows in ~5-7 s (517 MB raw; with OOP flop leads and later-street donks it took 22-28 s at 810 MB compressed and had the BB lead the flop so often that only 26-36% of its range check-called, 76% now); the 3-bet-pot Td9d6h2c turn spot (BB c-bets 33%, BTN calls) in ~4-5 s (325 MB; was 5.6-6.4 s); a river spot after flop and turn c-bets in ~13-20 s (632 MB). Whole requests: ~8-17 s locally. A default 3x raise on line streets pushed a turn spot to 1.4 GB compressed, so line streets have no default raises; a 3x check-raise for an OOP caller alone fit on the turn spot (555 MB, 14-20 s, not converged at 1%) but not on the river spot (2.3 GB raw / 1.2 GB compressed).

**Current-street actions and known villain hands.** `street_actions` (same entry shape as `line`, all on the current street, ending with villain's action) puts the reported node at hero's decision: `src/street.rs` adds each size used to the actor's current-street options (exact `N%` / `Nx` / `a`, no merging), adds a 3x (when the street has no raises) and an all-in raise for hero at the decision node only (`ActionTree::add_line`), locks hero's exact hand into hero's own actions before the solve, then walks to the decision after `finalize`. `nodes` = villain's last decision + hero's decision, `players` are at hero's decision, `hero_hand.actions[].ev` is the hand's EV per action (`expected_values_detail`; fold = 0, reported at every hero node), and `street_line` carries `matched`/`reason`, the size mapping and villain's range there. A villain range that reaches the decision with under 1 combo gets the street re-solved with villain's range locked into the line (`villain_rare`). `villain_hand` ("7c2d", "72o", "72s", "77", "72") makes villain's range exactly those combos (`INVALID_BOARD` if none survive the board and hero's cards), locks them into the street actions, and skips `line` narrowing. Bad street actions fall back to the start-of-street nodes with a reason. Locally: BTN AhKh vs BB 72o shove on Td9d6h solves in ~0.9 s (call +32.3bb, equity 64.75%); a 75% BB flop lead on Ks7d2c in ~13 s (tree budget: raises dropped, 855 MB); a turn lead after a flop line in ~31 s before the stage-1 changes (stage 1 ~28 s, now ~5-7 s).

Status codes: `200` ok, `422` input problems (`INVALID_REQUEST`, `INVALID_BOARD`, `INVALID_RANGE`, `INVALID_BET_SIZES`, `INVALID_STACKS`, `TREE_TOO_LARGE`), `503 SOLVER_BUSY`, `504 TIMEOUT`, `500 INTERNAL`, `401 UNAUTHORIZED`, `429 RATE_LIMITED` (`/admit` only; refused requests aren't counted). `/admit` answers `200 {"status":"ok"}` and records one solve.

Notes:
- Dash ranges may be ascending (`22-JJ`) or descending (`JJ-22`); the crate only accepts descending, so the service flips them.
- The full default sizes (33%/75% bets, 3x raises on every street) on an srp flop need ~20 GB raw / ~10 GB compressed; with the tree budget they're auto-simplified (raises dropped, then one size) instead of returning `TREE_TOO_LARGE`. Turn (~100 MB) and river (<1 MB) spots are fine.
- `PostFlopGame::with_config` allocates its node arena (64 B per action node per runout) before `memory_usage()` can be asked, so a 7-bet / 3-raise 200bb flop used to get the process OOM-killed. `src/tree_size.rs` now walks the would-be action tree without allocating it and returns `TREE_TOO_LARGE` once the action tree plus an upper bound on the arena (49 turns, 49x48 rivers, no isomorphism) passes `MAX_MEMORY_MB`. That case is rejected in ~3 ms. Trees that pass still get the full `memory_usage()` check.

## Example

`river.json`:

```json
{"board": "Td9d6hQc2s",
 "oop_range": "22-JJ,A2s-AJs,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,75s+,64s+,53s+,A2o-AJo,K9o+,Q9o+,J9o+,T9o",
 "ip_range": "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o",
 "starting_pot": 550, "effective_stack": 9750,
 "bet_sizes": {"flop": {"bet": "33%, 75%", "raise": "3x"},
               "turn": {"bet": "33%, 75%", "raise": "3x"},
               "river": {"bet": "33%, 75%, a", "raise": "3x"}},
 "hero": {"player": "ip", "hand": "AhKh"},
 "max_iterations": 1000, "target_exploitability_pct": 0.5}
```

```sh
curl -s -X POST localhost:8080/solve -H 'content-type: application/json' -d @river.json
```

Response (`200`, ~25 ms in release):

```json
{"status":"ok","exploitability_pct":0.4614,"iterations":80,"solve_ms":24,"memory_mb":0.4,"compressed":false,
 "players":{"oop":{"equity":0.4936,"ev":254.2},"ip":{"equity":0.5064,"ev":295.8}},
 "nodes":[
  {"line":[],"player":"oop","actions":[
    {"action":"Check","amount":0,"frequency":0.6473,"top_hands":["A3o","A4o","A5o","A7o","A8o","AJo"],
     "top_classes":[{"hand":"A3o","frequency":1.0},{"hand":"A4o","frequency":1.0},{"hand":"A5o","frequency":1.0},
                    {"hand":"A7o","frequency":1.0},{"hand":"A8o","frequency":1.0},{"hand":"AJo","frequency":1.0}]},
    {"action":"Bet","amount":182,"frequency":0.3155,"top_hands":["KTo","JTo","K9o","ATo","A9o","J9o"],
     "top_classes":[{"hand":"KTo","frequency":0.7447},{"hand":"JTo","frequency":0.6514},{"hand":"K9o","frequency":0.6324},
                    {"hand":"ATo","frequency":0.6054},{"hand":"A9o","frequency":0.5895},{"hand":"J9o","frequency":0.4956}]},
    {"action":"Bet","amount":413,"frequency":0.0372,"top_hands":["KQo","87s","J7s","K8s","TT","KQs"],"top_classes":[...]},
    {"action":"AllIn","amount":9750,"frequency":0.0,"top_hands":[],"top_classes":[]}]},
  {"line":["Check"],"player":"ip","actions":[
    {"action":"Check","amount":0,"frequency":0.443,"top_hands":["AKo","A8o","A7o","AJo","J9o","A2o"],"top_classes":[...]},
    {"action":"Bet","amount":182,"frequency":0.2086,"top_hands":["JTo","KTo","ATo","K9o","JTs","QTo"],"top_classes":[...]},
    {"action":"Bet","amount":413,"frequency":0.3484,"top_hands":["KJo","K8o","KQo","QJo","AQo","KK"],
     "top_classes":[{"hand":"KJo","frequency":0.8443},{"hand":"K8o","frequency":0.7847},{"hand":"KQo","frequency":0.8346},
                    {"hand":"QJo","frequency":0.7776},{"hand":"AQo","frequency":0.7441},{"hand":"KK","frequency":0.9992}]},
    {"action":"AllIn","amount":9750,"frequency":0.0,"top_hands":[],"top_classes":[]}]}],
 "hero_hand":{"hand":"AhKh","node":1,"equity":0.3651,"ev":200.82,"actions":[
    {"action":"Check","amount":0,"frequency":1.0},{"action":"Bet","amount":182,"frequency":0.0},
    {"action":"Bet","amount":413,"frequency":0.0},{"action":"AllIn","amount":9750,"frequency":0.0}]}}
```

`top_classes` groups the acting player's combos into hand classes (`KK`, `KQs`, `KQo`) and lists up to 6, ordered by how often each takes the action (compared at 1% resolution), ties broken by the range weight it sends into the action (sum of weight × frequency). Each class's `frequency` is how often it takes the action: the weight-averaged strategy over its live combos (board-blocked and zero-weight combos are skipped). `top_hands` repeats the class names as plain strings for older clients. Grouping happens in `src/summary.rs` (`top_classes`).

## Acceptance checks (M1/M2)

Same body with `board` changed. `turn.json` = board `Td9d6hQc`; `flop_small.json` = board `Td9d6h` with sizes flop `50%`, turn/river `75%`, no raises (~520 MB with these narrower ranges).

```sh
# M1: duplicate card -> 422 INVALID_BOARD
curl -s -w ' %{http_code}\n' -X POST localhost:8080/solve -H 'content-type: application/json' \
  -d "$(sed 's/Td9d6hQc2s/Td9d6hTd2s/' river.json)"

# M2: memory cap -> 422 TREE_TOO_LARGE
MAX_MEMORY_MB=1 cargo run --release &
curl -s -w ' %{http_code}\n' -X POST localhost:8080/solve -H 'content-type: application/json' -d @turn.json

# M2: timeout -> 504 TIMEOUT (or 200 partial if close to target)
SOLVE_TIMEOUT_SECS=1 cargo run --release &
curl -s -w ' %{http_code} %{time_total}s\n' -X POST localhost:8080/solve -H 'content-type: application/json' -d @flop_small.json

# Queue: B waits behind A, streaming its position, then solves
curl -s -o /dev/null -w 'A %{http_code}\n' -X POST localhost:8080/solve -H 'content-type: application/json' -d @flop_small.json &
sleep 0.3
curl -sN -X POST localhost:8080/solve -H 'content-type: application/json' -H 'accept: application/x-ndjson' -d @river.json | cut -c1-80
# {"type":"queued","position":1}
# {"type":"solving"}
# {"type":"result","status":"ok",...

# Queue full: with 1 running + 5 waiting, a 7th request gets 503 SOLVER_BUSY immediately
```
