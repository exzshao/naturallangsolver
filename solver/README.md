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

Status codes: `200` ok, `422` input problems (`INVALID_REQUEST`, `INVALID_BOARD`, `INVALID_RANGE`, `INVALID_BET_SIZES`, `INVALID_STACKS`, `TREE_TOO_LARGE`), `503 SOLVER_BUSY`, `504 TIMEOUT`, `500 INTERNAL`.

Notes:
- Dash ranges may be ascending (`22-JJ`) or descending (`JJ-22`); the crate only accepts descending, so the service flips them.
- The full default sizes (33%/75% bets, 3x raises on every street) on an srp flop need ~20 GB raw / ~10 GB compressed, so they return `TREE_TOO_LARGE` at the default cap. Turn (~100 MB) and river (<1 MB) spots are fine.
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
    {"action":"Check","amount":0,"frequency":0.6473,"top_hands":["3d3c","3h3c","3s3c","3h3d","3s3d"]},
    {"action":"Bet","amount":182,"frequency":0.3155,"top_hands":["Kh7h","Kc4c","Kd4d","Kc7c","Ks4s"]},
    {"action":"Bet","amount":413,"frequency":0.0372,"top_hands":["8d7d","8h7h","8s7s","8c7c","Jh7h"]},
    {"action":"AllIn","amount":9750,"frequency":0.0,"top_hands":[]}]},
  {"line":["Check"],"player":"ip","actions":[
    {"action":"Check","amount":0,"frequency":0.443,"top_hands":["Kh2h","Kd2d","Kc2c","3s3d","3s3h"]},
    {"action":"Bet","amount":182,"frequency":0.2086,"top_hands":["JhTc","JhTh","JhTs","JsTc","JsTh"]},
    {"action":"Bet","amount":413,"frequency":0.3484,"top_hands":["KsKh","KhKd","KhKc","KsKd","KsKc"]},
    {"action":"AllIn","amount":9750,"frequency":0.0,"top_hands":[]}]}],
 "hero_hand":{"hand":"AhKh","node":1,"equity":0.3651,"ev":200.82,"actions":[
    {"action":"Check","amount":0,"frequency":1.0},{"action":"Bet","amount":182,"frequency":0.0},
    {"action":"Bet","amount":413,"frequency":0.0},{"action":"AllIn","amount":9750,"frequency":0.0}]}}
```

## Acceptance checks (M1/M2)

Same body with `board` changed. `turn.json` = board `Td9d6hQc`; `flop_small.json` = board `Td9d6h` with sizes flop `50%`, turn/river `75%`, no raises (~520 MB).

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

# M2: concurrency -> second request gets 503 SOLVER_BUSY
curl -s -o /dev/null -w 'A %{http_code}\n' -X POST localhost:8080/solve -H 'content-type: application/json' -d @flop_small.json &
sleep 0.3
curl -s -w ' B %{http_code}\n' -X POST localhost:8080/solve -H 'content-type: application/json' -d @river.json
```
