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
- **`solver/`**: thin HTTP service around [b-inary/postflop-solver](https://github.com/b-inary/postflop-solver). Checks tree size before allocating, enforces a timeout, runs one solve at a time with a small FIFO queue behind it (the UI shows `QUEUED (#N)` while waiting).
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
| `SOLVER_API_KEY` | unset | required `x-solver-key` header; unset disables auth |
| `RATE_LIMIT_PER_IP_HOUR` | 100 | `/admit` slots per IP per rolling hour |
| `RATE_LIMIT_GLOBAL_DAY` | 10000 | `/admit` slots per rolling 24 hours |
| `QUEUE_MAX_WAITING` | 5 | solves that may wait behind the running one; more get `SOLVER_BUSY` |
| `QUEUE_MAX_WAIT_SECS` | 120 | longest wait in the queue before `SOLVER_BUSY` |

## Deploy

Live at https://nlpsolver.com. The solver runs on Fly.io, the app on Vercel.

**Solver (Fly, `solver/fly.toml`)**: app `nlpsolver-solver`, region `sjc`, one `shared-cpu-4x` / 2 GB machine that is suspended when idle and resumed by the next request. Suspend keeps process memory, so the rate-limit counters survive idle periods; a deploy or a lost snapshot means a cold start.

```sh
cd solver
fly secrets set SOLVER_API_KEY=<random hex>      # e.g. openssl rand -hex 32
fly deploy --remote-only --ha=false
fly scale count 1 && fly machines list           # cost cap: exactly one machine
```

**App (Vercel)**: project `nlpsolver`, Root Directory `app`, Fluid compute on. `/api/solve` sets `maxDuration = 300` (LLM + up to 120 s in the solver queue + up to 90 s solving) and streams progress as NDJSON (SPEC §7).

```sh
vercel env add OPENAI_API_KEY production        # use a key with a spend limit
vercel env add SOLVER_API_KEY production        # same value as the Fly secret
vercel env add SOLVER_URL production            # https://nlpsolver-solver.fly.dev
vercel env add LLM_MODEL production             # openai:gpt-6-luna
vercel deploy --prod                            # from the repo root
```

**Safeguards**

- Every solver route except `/health` needs `x-solver-key` = `SOLVER_API_KEY` (unset means no auth, for local dev).
- Before the LLM call, the app asks the solver's `POST /admit {"ip"}` for a slot. Limits are in-memory sliding windows: `RATE_LIMIT_PER_IP_HOUR` (100) and `RATE_LIMIT_GLOBAL_DAY` (10000). Refusals return `RATE_LIMITED`; if `/admit` can't be reached the app refuses too (`SOLVER_UNAVAILABLE`). Counters survive auto-suspend but reset on deploys and cold starts.
- LLM output is capped at 1200 tokens, input at 2000 characters. The mock model is refused in production.

## Tests

```sh
cd solver && cargo test
cd app && npm test            # unit + route tests
cd app && npm run evals       # live LLM extraction evals (costs a few cents)
```

## Limits

Heads-up only. Postflop only. Ranges start as default preflop ranges for the positions and pot type. On turn and river spots with earlier postflop betting, the solver first narrows both ranges with a simplified flop solve of that line (only the sizes you described, one size and no raises elsewhere, 1% exploitability), then solves the current street from the narrowed ranges; if the line can't be replayed, the full ranges are used and an assumption says why. Flop spots use a simplified tree (one bet size, no raises) to fit in memory.

## License

The solver engine, postflop-solver, is AGPL-3.0, and its upstream development is suspended.
