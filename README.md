# NLP SOLVER

Describe a heads-up postflop No-Limit Hold'em spot in plain English. Get a GTO strategy back.

```
"BTN vs BB single raised pot, 100bb deep, flop Td9d6h, I'm on the button with AhKh, BB checks to me."
```

An LLM reads the description and extracts the spot (board, positions, pot, stacks, ranges, bet sizes, hero hand). A Rust solver computes the strategy. Anything you leave out gets a sensible default, and every default is listed as an assumption. The LLM never invents strategy: if the spot can't be parsed or solved, the app says "Can't solve this" and why.

## How it works

```
browser ──▶ app/ (Next.js)  ──▶ LLM (structured extraction)
                 │
                 └──▶ solver/ (Rust, axum) ──▶ postflop-solver
```

- **`app/`**: Next.js UI and `/api/solve` route. Extraction uses the Vercel AI SDK with a zod schema, so the model is swappable via one env var (`LLM_MODEL=provider:model`). Defaults, validation, and action-history math (pot and stacks from the betting) are pure functions in `app/src/lib/`.
- **`solver/`**: thin HTTP service around [b-inary/postflop-solver](https://github.com/b-inary/postflop-solver). Checks tree size before allocating, enforces a timeout, runs one solve at a time.
- **`SPEC.md`**: full spec: schema, defaults, every can't-solve reason, the `/solve` contract.

## Run locally

Needs Rust (stable), Node 20+, and an OpenAI API key.

```sh
# 1. secrets: create .env in the repo root
cat > .env <<'EOF'
OPENAI_API_KEY=sk-...
SOLVER_URL=http://localhost:8080
LLM_MODEL=openai:gpt-6-luna
EOF
ln -s ../.env app/.env.local

# 2. solver (terminal 1)
cd solver && cargo run --release

# 3. app (terminal 2)
cd app && npm install && npm run dev
```

Open http://localhost:3000.

No API key? Set `LLM_MODEL=mock:fixture` for canned extractions (dev only).

### Solver settings

| Env var | Default | |
|---|---|---|
| `PORT` | 8080 | |
| `MAX_MEMORY_MB` | 1024 | larger trees return `TREE_TOO_LARGE` |
| `SOLVE_TIMEOUT_SECS` | 90 | |
| `MAX_ITERATIONS` | 1000 | |

## Tests

```sh
cd solver && cargo test
cd app && npm test            # unit + route tests
cd app && npm run evals       # live LLM extraction evals (costs a few cents)
```

## Limits

Heads-up only. Postflop only. Ranges are default preflop ranges for the positions and aren't narrowed by earlier action. Flop spots use a simplified tree (one bet size, no raises) to fit in memory.

## License

The solver engine, postflop-solver, is AGPL-3.0, and its upstream development is suspended.
