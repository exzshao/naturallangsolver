# Solver Service

Minimal stateless HTTP service exposing the Rust postflop solver via POST /solve.

## Run locally

```bash
cd rust/solver-service
cargo run
# listens on 0.0.0.0:8080 (set PORT to override)
```

Health:
```bash
curl -s -X POST http://localhost:8080/healthz
```

Solve (quick example):
```bash
curl -s -X POST http://localhost:8080/solve \
  -H 'Content-Type: application/json' \
  -d '{
    "config": {
      "card_config": {
        "range": [
          "66+,A8s+,A5s-A4s,AJo+,K9s+,KQo,QTs+,JTs,96s+,85s+,75s+,65s,54s",
          "QQ-22,AQs-A2s,ATo+,K5s+,KJo+,Q8s+,J8s+,T7s+,96s+,86s+,75s+,64s+,53s+"
        ],
        "flop": "Td9d6h",
        "turn": "Qc",
        "river": null
      },
      "tree_config": {
        "starting_pot": 200,
        "effective_stack": 900,
        "rake_rate": 0.0,
        "rake_cap": 0.0,
        "flop_bet_sizes": ["60%, e, a", "60%, e, a"],
        "turn_bet_sizes": ["60%, e, a", "60%, e, a"],
        "river_bet_sizes": ["60%, e, a", "60%, e, a"],
        "turn_donk_sizes": null,
        "river_donk_sizes": "50%",
        "add_allin_threshold": 1.5,
        "force_allin_threshold": 0.15,
        "merging_threshold": 0.1
      }
    },
    "options": { "max_iters": 100, "target_exploitability": 10.0, "compressed": false, "verbose": false },
    "node_path": [1,1],
    "lock_strategy": null
  }'
```

## Configuration
- PORT: server port (default 8080)

## Notes
- Stateless: send full config per request. No Redis required.
- Save/load: re-enable bincode feature on postflop-solver if needed and pin a compatible version.


