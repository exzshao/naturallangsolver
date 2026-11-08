# Running the solver in the browser (WASM): design spike

Status: spike, November 2026. Prototype code is in `wasm-spike/`. Nothing in `app/` or
`solver/` was changed.

## TL;DR

- **Feasible for river and turn spots, and for the slim flop tree.** The same
  `postflop-solver` commit builds to wasm32 with threads (wasm-bindgen-rayon over
  `SharedArrayBuffer`) and SIMD. In headless Chrome 156 on this M1 (8 cores, 8 GB) it
  gives the same results as native (same iteration counts and exploitability) at
  **1.4-1.5x native time**. That requires the crate's `custom-alloc`; without it, wasm
  is 2.7-3x native. Measured: river 27 ms (native 14 ms), default turn 5.4 s (native
  3.6 s), slim flop 10.0 s (native 7.1 s). Table in §7.
- **The full default flop tree (33/75 + 3x on every street) is not feasible in a
  browser.** It needs 19.6 GB raw or 10.0 GB compressed. wasm32 caps at 4 GB. Memory64
  caps at 16 GB and runs 10-100% slower (10-15% here). Chrome and Firefox ship it;
  Safari doesn't. A wasm64 + threads build of the spike runs in Chrome 156 and grows to
  16 GB. The largest flop tree that is practical in wasm32 is "two bet sizes and no raises" (or one size plus 3x
  raises), at about 1.5 GB compressed. Measured in Chrome it runs 2.1 s per iteration,
  so 4-7 minutes to 0.5%. That isn't interactive (§4).
- **Recommended setup:** the server keeps the LLM extraction, the defaults and the rate
  limit. The browser runs stage 1 (narrowing) and stage 2 (the solve) in a Web Worker
  and streams progress. The Fly solver stays as the fallback for devices without
  cross-origin isolation or with too little memory. Rough effort: **1.5-2 weeks** (§6).
- **WebGPU:** skip for now. There is no open exact (full-tree) GPU solver for HUNL
  postflop to port, the
  per-buffer limits are small, and it would mean rewriting the CFR kernels (§5).

## 1. How b-inary's WASM Postflop does it

Sources: [repo README](https://github.com/b-inary/wasm-postflop),
[`rust/solver-mt/Cargo.toml` and `.cargo/config.toml`](https://github.com/b-inary/wasm-postflop/tree/main/rust/solver-mt),
[`src/worker.ts`](https://github.com/b-inary/wasm-postflop/blob/main/src/worker.ts),
[`server.js`](https://github.com/b-inary/wasm-postflop/blob/main/server.js).

- **Build:** `rustup run nightly wasm-pack build --target web` with
  `rustflags = "-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 -C link-arg=--max-memory=4294967296"`
  and `[unstable] build-std = ["panic_abort", "std"]`. std is rebuilt with atomics, which
  needs nightly. `wasm-opt -O4` runs on the release build.
- **Two builds:** `solver-mt` (rayon) and `solver-st` (single thread). The worker picks
  `st` on Safari and iOS (`isMTSupported()` checks for `safari` or `iOS` with
  `detect-browser`), and `mt` everywhere else.
- **Threads:** a copy of GoogleChromeLabs' wasm-bindgen-rayon (`rayon_adapter.rs`) that
  adds `exitThreadPool` so the pool can be resized. Each rayon thread is a Web Worker
  sharing one `WebAssembly.Memory({shared: true})`. This requires cross-origin isolation:
  `server.js` sends `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- **SIMD:** `+simd128`. The crate has a hand-written `std::arch::wasm32` path for
  `slice_absolute_max` (used by 16-bit compression, `src/utility.rs`). Everything else
  relies on LLVM auto-vectorization.
- **Allocator:** the crate's `custom-alloc` feature (a stack allocator on nightly
  `allocator_api`). Its doc comment says the default allocator "is not efficient in a
  multi-threaded WASM environment". It was the single biggest factor in my runs: wasm
  without it is 2.7-3x native, and with it 1.4-1.5x (§7).
- **Memory:** `--max-memory=4294967296` (65,536 pages, the wasm32 maximum). The UI
  offers 16-bit compressed storage, which halves memory. The README benchmark shows
  660 MB compressed vs 1.25 GB in 32-bit mode for the same flop.
- **Progress:** the JS side owns the loop. Through Comlink it calls `solve_step(i)` once
  per iteration and `exploitability()` every few iterations, then posts those values to
  the UI. Rust never calls back into JS.
- **Speed:** its README says Desktop Postflop (native) was "the clear winner", with
  WASM about 2x slower. Example: 33.4 s vs 20.0 s at 0.5% with 6 threads (Chrome 108).
- **Status:** development suspended in October 2023 (same as the engine).
- **License:** AGPL-3.0-or-later, like `postflop-solver`. Sending a `.wasm` built from it
  to browsers counts as *conveying object code*, so GPLv3 §6 applies. Each user must be
  able to get the Corresponding Source of the combined work: the Rust wrapper, the
  worker, and the JS glue that loads it. AGPL §13 already applies to us today because
  we serve the solver over the network. This repo is public and the footer links to it,
  so the obligation is already met. Keep linking the exact source revision, and keep
  other code that links the wasm under a compatible license. wasm-bindgen and
  wasm-bindgen-rayon are MIT/Apache-2.0, which is compatible.

## 2. Memory: wasm32 vs Memory64

| | wasm32 | Memory64 (wasm64) |
|---|---|---|
| Address space | 4 GB max (65,536 x 64 KB pages); V8 has allowed the full 4 GB since 2020 ([v8.dev](https://v8.dev/blog/4gb-wasm-memory)) | 16 GB declared maximum in V8 (`kSpecMaxMemory64Pages` = 262,144 pages, [wasm-limits.h](https://chromium.googlesource.com/v8/v8/+/master/src/wasm/wasm-limits.h)); browsers cap at 16 GB ([SpiderMonkey](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html)) |
| Chrome / Edge | yes | 133+ (Feb 2025) |
| Firefox | yes | 134+ (Jan 2025) |
| Safari / iOS | yes | **not supported**; Baseline has been blocked by Safari for 21 months ([web-features](https://web-platform-dx.github.io/web-features-explorer/features/wasm-memory64)) |
| Speed | baseline | 10% to over 100% slower. Bounds checks can't be removed with guard pages ([SpiderMonkey, Jan 2025](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html)) |
| Rust | `wasm32-unknown-unknown` tier 2 (threads need nightly + build-std) | `wasm64-unknown-unknown` is **tier 3**, with no prebuilt std, so nightly + build-std ([rustc docs](https://doc.rust-lang.org/rustc/platform-support/wasm64-unknown-unknown.html)) |
| wasm-bindgen threads | yes | 0.2.127 rejected memory64 in its threads transform; 0.2.130 handles i64 shared memory ([source](https://docs.rs/crate/wasm-bindgen-cli-support/0.2.130/source/src/transforms/threads/mod.rs)). **Verified in the spike:** wasm64 + rayon + SIMD runs in Chrome 156 and grows to 16 GB (§7). |

**How much memory a tab really gets.** On desktop Chrome or Firefox with 16 GB or more
of RAM, a tab can use a 3-4 GB wasm32 heap. With 8 GB of RAM (like this machine),
anything over about 2-3 GB pushes the system into swap. Phones are much tighter. On
iOS, Safari kills the tab (jetsam) instead of failing `memory.grow`, with reports of
kills around 1.4 GB. A WebKit comment puts Chrome Android's practical limit at about
500-700 MB because of address-space fragmentation, and Firefox at 2 GB
([WebKit bug 221530](https://bugs.webkit.org/show_bug.cgi?id=221530),
[emscripten-discuss](https://groups.google.com/g/emscripten-discuss/c/SlmrsE9hpwE)).
So the budgets are about 3 GB on desktop, 1 GB on Android, and 300-500 MB on iOS. The
river (<1 MB) and turn (~100 MB raw, ~52 MB compressed) spots fit everywhere. The slim
flop (517 MB raw, 265 MB compressed) fits on desktop, and on phones only when
compressed.

`navigator.deviceMemory` (Chromium only, capped at 8) can choose the memory cap. Safari
doesn't expose it, so on Safari it has to be guessed from the platform.

## 3. Threads need cross-origin isolation (COOP/COEP)

`SharedArrayBuffer` (and so threads) works only when `self.crossOriginIsolated` is true.
That needs both headers on the document:

```ts
// app/next.config.ts (Next 16; see node_modules/next/dist/docs/.../next-config-js/headers.md)
async headers() {
  return [{
    source: "/:path*",
    headers: [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
    ],
  }];
}
```

Vercel applies `next.config` headers to pages and static files. `vercel.json`
`headers` also works.

What this breaks for us:

- **Fonts:** nothing. `next/font/google` downloads the font at build time and serves it
  from our own origin; the docs say "No requests are sent to Google by the browser"
  (`app/node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md`).
  The app uses `IBM_Plex_Mono` from `next/font/google` (`app/src/app/layout.tsx`).
- **Third-party scripts and embeds:** the app has none. There is no analytics, no
  iframe, and no external image. The only external URLs are two GitHub links (`<a>`
  navigation is fine). The inline theme script is same-origin. If Vercel Analytics or
  Speed Insights is added later, it loads from our own origin (`/_vercel/...`) and is
  fine. Any cross-origin `<img>`, `<script>` or `<iframe>` needs a CORP or CORS header
  or the `crossorigin` attribute.
- **COOP `same-origin`:** cuts the `window.opener` link to and from popups. That
  matters for OAuth popups or payment popups, and we have neither.
- **`credentialless`:** a looser COEP value that loads cross-origin resources without
  credentials. Chrome and Firefox (119+) support it, Safari doesn't
  ([caniuse](https://caniuse.com/mdn-http_headers_cross-origin-embedder-policy_credentialless)).
  Use `require-corp` so Safari gets isolation too.
- **Scope:** isolation can be limited to the solve page. That doesn't help here because
  the app is one page.
- **In-app browsers and webviews:** some don't support isolation. Feature-detect
  `crossOriginIsolated` and fall back (§6).

## 4. Performance and what fits

Measured in §7: wasm with threads, SIMD and `custom-alloc` runs at **1.4-1.5x native**
per iteration with raw storage and **2.0x with compressed storage**. Iteration counts
and exploitability are the same as native. b-inary measured about 2x. The estimates
below start from measured native ms/iteration on this M1 (8 cores, comparable to a
typical 8-core laptop) and assume 100-200 iterations to reach 0.5% on big flops.

Flop trees (srp Td9d6h, 5.5 bb pot, 97.5 bb stacks, ranges from the README) were
measured with `memory_usage()` in `wasm-spike/sizes.json`. Native ms/iteration scales
roughly with tree size: 118 ms per iteration at 517 MB raw, and 1.05 s at 3.0 GB
raw / 1.56 GB compressed (tree C). The slim tree reaches 0.5% in 60 iterations, and
tree C is at 64% after 10.

| Tree (bets / raises by street) | raw | compressed | fits in | native to 0.5% (est.) | browser to 0.5% (est.) |
|---|---|---|---|---|---|
| River, 33/75/a + 3x | 0.36 MB | 0.25 MB | anywhere | 14 ms (measured) | 27 ms (measured) |
| Turn, 33/75 + 3x, river 33/75/a + 3x | 102 MB | 52 MB | anywhere | 3.6 s (measured) | 5.4 s (measured) |
| A. Flop slim 50 / 75 / 75, no raises (app today) | 517 MB | 265 MB | desktop; phone if compressed | 7.1 s (measured) | 10.0 s (measured) |
| B. 33,75 every street, no raises | 3.0 GB | 1.54 GB | wasm32, compressed, desktop | ~2-3.5 min | ~4-7 min |
| C. 50 / 75 / 75 + 3x on every street | 3.0 GB | 1.56 GB | wasm32, compressed, desktop | ~2-3.5 min (1.05 s/it measured) | ~4-7 min (2.1 s/it measured) |
| D. 33,75 every street, 3x on river only | 6.4 GB | 3.3 GB | wasm32 at the edge (3.3 of 4 GB, only with ≥16 GB RAM) | ~4-7 min | ~8-15 min |
| E. 33,75, 3x on turn and river | 12.0 GB | 6.1 GB | Memory64 only (Chrome/Firefox), ≥16 GB RAM | ~8-15 min | ~20-35 min |
| F. 33,75 + 3x on every street (default sizes) | 19.6 GB | 10.0 GB | Memory64 only, ≥24-32 GB RAM | ~12-25 min | ~30-60 min |

The F figures match the README's "~20 GB raw / ~10 GB compressed". **A full flop tree is
not feasible in-browser.** It doesn't fit wasm32. On Memory64 it is Chrome/Firefox only,
needs a 32 GB machine, and would take half an hour or more. The largest flop tree that
is practical in-browser is the slim tree we already use. B or C (about 1.5 GB
compressed) works on desktops with 16 GB or more but takes minutes, which might be OK as
an opt-in "deep solve" with a progress bar. They don't fit on phones.

Stage-1 narrowing uses a simplified flop tree (the line's sizes, one size and no raises
elsewhere, 1% target, at most 300 iterations). It is about 150 MB and 2.2 s native on
the 3-bet-pot example (solver README), so about 3-4 s in the browser.

## 5. Newer options: WebGPU, WebNN

- **WebGPU** now ships in Chrome/Edge, Safari 26 (macOS, iOS, iPadOS), and Firefox
  141+ on Windows and 145+ on Apple Silicon macOS. Linux, Android and Intel Macs are
  still in progress in Firefox ([web.dev](https://web.dev/blog/webgpu-supported-major-browsers)).
- **GPU CFR research:** Kim's "GPU-Accelerated CFR" (dense/sparse matrix ops, up to
  about 22x over C++ on large games, slower on small ones;
  [arXiv 2408.14778](https://arxiv.org/abs/2408.14778)). CFR as linear algebra
  ([arXiv 2605.14277](https://arxiv.org/abs/2605.14277)). GPU-CFR (Sep 2026 preprint,
  CUDA graphs, 30-80x over earlier GPU CFR on an A100;
  [arXiv 2609.11923](https://arxiv.org/abs/2609.11923)). All of it is CUDA, and none of
  it handles HUNL postflop trees with card isomorphism the way postflop-solver does.
  DEEPFOLD (closed source, CUDA) claims 6-10x over its own CPU path.
  holdem.computer runs in the browser on custom WebGPU kernels ported from PyTorch
  ([discussion](https://zeli.app/story/49111523)). The repo it was ported from,
  [phulin/poker2](https://github.com/phulin/poker2), is a ReBeL-style solver: CFR over
  public belief states to the end of the street, with a trained value network at the
  cutoff. That design avoids the full-tree memory wall, but it needs a trained network
  and is a different product from an exact solver. No performance numbers are
  published.
- **Feasibility for us:** postflop-solver's inner loop is irregular. It walks the tree
  recursively, with per-runout chance nodes, hand-strength sorting for showdown
  evaluation, and rayon over chance children. Moving it to WGSL means writing a new
  solver, not porting one: flatten the tree level by level, write regret-matching and
  showdown kernels, and validate them against the CPU. WebGPU's default limits are
  128 MB per storage-buffer binding and 256 MB per buffer. Adapters can raise them
  (often to 1-4 GB on desktop), but the turn spot (100 MB) is near the default, and the
  flop trees need multi-buffer sharding. GPU memory is also no bigger than the wasm
  heap on most laptops, so it doesn't fix the flop memory wall.
- **WebNN** is for neural-net inference. It would only matter with a DeepStack/ReBeL
  design (a value network at depth limits, like poker2). That is a research project,
  and we would have to train the network.
- **Verdict:** no for now. Effort is weeks to months, with a high risk that the result
  is slower than wasm on integrated GPUs, and the memory limit stays. Revisit only if an
  open WGSL postflop solver shows up or we decide to build a depth-limited (value-net)
  solver.

## 6. Proposed setup

```
browser (page)                               server (Vercel)
  │ POST /api/extract {text} ───────────────▶ admit (rate limit) → LLM → defaults/validate
  │ ◀── {request: SolverRequest, spot, assumptions, notes}   (no solve)
  │
  ├─ capable? ──yes──▶ SolverWorker (wasm32 MT+SIMD, rayon pool in N sub-workers)
  │                     narrowing → solving(iter, expl%) → result (SolveResponse JSON)
  │                     presentResult() runs client-side (pure, app/src/lib/present.ts)
  │
  └─ no / failed ────▶ POST /api/solve (today's path, Fly solver, queue, NDJSON)
```

**Server.** Split `/api/solve` into `/api/extract` (admit + LLM + `prepareSolve`). It
returns the `SolverRequest` that `buildSolverRequest` makes today, plus the spot and the
assumptions `presentResult` needs. Keep `/api/solve` unchanged as the fallback.

**Rate limiting.** `/admit` lives in the Fly solver today, so moving solves to the
browser still leaves the LLM limit needing a home. Options:

- (a) Keep a tiny Fly machine for `/admit` and fallback solves. This is the least work.
- (b) Move the sliding windows to Vercel KV / Upstash Redis and keep Fly only as the
  fallback.

Either way, limit the LLM, not the solve. Client solves cost us nothing, and re-solving
with edited sizes could skip the LLM entirely.

**Queue.** Client solves don't queue. The Fly queue stays only for the fallback, and
its load drops a lot.

**Rust.** Move `api.rs`, `config.rs`, `error.rs`, `line.rs`, `solve.rs`, `summary.rs`,
`tree_size.rs` into a `solver-core` crate with no tokio or axum. `solver/` keeps
`routes`, `queue`, `auth` and `rate_limit` and depends on it. A new `solver-wasm` crate
(cdylib) exposes:

```rust
#[wasm_bindgen] pub fn solve(request_json: &str, max_memory_mb: u32, timeout_ms: u32,
                             on_event: &js_sys::Function) -> Result<String, JsError>
// on_event({type:"narrowing"}) / ({type:"solving"}) /
//          ({type:"progress", phase, iteration, exploitability_pct, elapsed_ms})
// returns SolveResponse JSON, or a §6 error body {status:"cant_solve", reason, message}
```

It takes the same JSON as `POST /solve` and returns the same success and error bodies,
so `types.ts` and `present.ts` don't change. Changes needed:

- `std::time::Instant` → `web_time::Instant` (std's panics on wasm32).
- `tracing` becomes a no-op.
- `run_with`'s `on_phase` becomes `on_event`, and the iteration loop in
  `build_and_solve` reports `(iteration, exploitability)` every 10 iterations (it
  already computes this every 10 iterations).
- `MAX_MEMORY_MB` comes from the client: about 2,500 desktop, 800 Android, 400 iOS,
  from `navigator.deviceMemory` or a platform guess.
- The pre-check and memory check keep the tab from OOMing.

**Worker API (TS).**

```ts
type SolverEvent =
  | { type: "narrowing" } | { type: "solving" }
  | { type: "progress"; phase: "narrowing" | "solving"; iteration: number; exploitabilityPct: number; elapsedMs: number }
  | { type: "result"; body: SolverOkResponse } | { type: "error"; body: CantSolveResponse };
solveInBrowser(req: SolverRequest, opts: { signal: AbortSignal; onEvent(e: SolverEvent): void }): Promise<SolverOkResponse | CantSolveResponse>
```

These events map onto the existing `StatusEvent`/`Progress` (`narrowing`, `solving`).
`progress` adds an iteration count and an exploitability-vs-target bar, which is a
small UI change. Cancelling with `worker.terminate()` frees the memory. The next solve
spawns a fresh worker, which costs about 50-100 ms plus a cached compile. Keep one warm
worker between solves.

**Who solves where** (decided before extraction finishes):

| Condition | River | Turn (+ narrowing) | Flop (slim) |
|---|---|---|---|
| `crossOriginIsolated` && `WebAssembly` && ≥4 cores && desktop | browser MT | browser MT | browser MT |
| Phone with isolation | browser MT | browser MT (compressed) | Fly |
| No isolation (webview, old Safari) | browser ST (river: ~15-30 ms on 1 thread) | Fly, or browser ST on desktop (~20 s) | Fly |
| Browser solve fails (OOM, trap, too slow) | retry once on Fly | Fly | Fly |

Ship an `st` build without atomics as well, like wasm-postflop. Safari has supported
`SharedArrayBuffer` under isolation since 15.2, so the `mt` build should work there.
wasm-postflop's Safari opt-out dates from 2022-23, so test before trusting either way.

**Caching.** The spike's `.wasm` is 1.66 MB raw, 526 KB gzip and 373 KB brotli,
before `wasm-opt`. The full `solver-core` adds summary and line code, so expect about
400-500 KB brotli. Serve it as a content-hashed static asset with
`Cache-Control: public, max-age=31536000, immutable`, and load it with
`WebAssembly.compileStreaming` (V8 caches the compiled code). Start fetching and
compiling when the page loads, while the LLM runs (2-5 s), so the solver is warm by the
time extraction returns.

**Bundling gotcha.** wasm-bindgen-rayon's `workerHelpers.js` does `import('../../..')`
to load the package's main JS. Bundlers resolve that through `package.json`. A plain
static server, or `public/` on Vercel, returns 404 for the directory URL, and
`initThreadPool` then hangs with no error (I hit this). Either let Turbopack bundle the
package (untested with Next 16 and Turbopack), or ship the package from `public/` and
rewrite that import to `../../../<name>.js` in a post-build step.

**Effort (rough):**

| Task | Time |
|---|---|
| `solver-core` split + `web_time` + progress callback, tests still pass | 1-2 days |
| `solver-wasm` crate, build script (nightly pin, build-std, wasm-bindgen CLI pinned to the crate version, wasm-opt, workerHelpers patch), CI artifact | 1-2 days |
| Next: headers, worker module, `/api/extract`, client `presentResult`, progress UI, fallback logic | 2-3 days |
| `st` build, capability detection, Safari, iOS and Android testing, memory caps | 2 days |
| Rate limit relocation (option b) | 0.5-1 day |
| **Total** | **about 1.5-2 weeks** |

## 7. Prototype results (`wasm-spike/`)

What it does: `src/lib.rs` has one `run_spot()` used by both a native binary
(`src/bin/native.rs`) and a wasm export (`solve_spot`, with a JS progress callback). It
uses the same `postflop-solver` commit as `solver/Cargo.lock` (`9d1509f`).

- `build.sh` builds `pkg/` (default allocator) and `pkg-alloc/` (`custom-alloc`), each
  as wasm32 + atomics + SIMD with `-Z build-std`, then wasm-bindgen 0.2.130
  `--target web`.
- `serve.mjs` is a static server that sends COOP/COEP.
- `run.mjs` drives the installed Chrome (headless, playwright-core from `/tmp/pw`)
  through `www/index.html` → `www/worker.js`.
- `bench.sh` interleaves native and wasm runs and keeps the best time per spot.

Setup: Apple M1 (4P+4E cores), 8 GB, macOS 26, Chrome 156 headless,
`navigator.hardwareConcurrency` = 8, `crossOriginIsolated` = true, rayon with 8 threads
in both. rustc nightly 1.98 (2026-06-21), LTO, codegen-units 1. **Caveat: the machine
was shared with other agents (load average 13-70 during the runs).** Single runs varied
by up to 2x, so the table shows the best of 3 interleaved rounds.

Best of 3 interleaved rounds. Solve time only (build and allocation are separate and
small). "alloc" means the crate's `custom-alloc` feature.

| Spot | iters | native | wasm32 (default alloc) | **wasm32 + custom-alloc** | wasm64 + custom-alloc (1 run) |
|---|---|---|---|---|---|
| River (README) to 0.5% | 80 | 14 ms | 27 ms (1.9x) | **27 ms (1.9x)** | 27 ms |
| River, 200 iterations | 200 | 35 ms | 47 ms (1.3x) | **48 ms (1.4x)** | 52 ms |
| Turn 33/75 + 3x to 0.5% | 190 | 3.62 s (19.0 ms/it) | 10.73 s (3.0x) | **5.41 s (1.5x)** | 6.22 s (1.7x) |
| Turn, 100 iterations | 100 | 2.01 s | 5.69 s (2.8x) | **2.99 s (1.5x)** | 3.40 s |
| Turn, compressed, to 0.5% | 180 | 3.79 s | 10.38 s (2.7x) | **7.56 s (2.0x)** | 9.05 s |
| Flop slim (50/75/75, no raises) to 0.5% | 60 | 7.10 s (118 ms/it) | 20.16 s (2.8x) | **10.03 s (1.4x)** | 10.98 s (1.5x) |
| Flop C (50/75/75 + 3x), compressed, 1.56 GB, 10 iterations (1 run) | 10 | 10.5 s (1.05 s/it) | | **21.0 s (2.0x)** | |

Raw rows are in `wasm-spike/bench-main.ndjson`. In wasm the **custom allocator is
mandatory**: dlmalloc behind a global lock makes threaded wasm 2.7-3x slower than
native, and the stack allocator brings it to 1.4-1.5x. Natively it makes no difference.
Compressed (16-bit) storage costs more in wasm (2.0x vs 1.5x) because of the extra
integer/float conversions.

Exploitability and iteration counts match between native and wasm on every spot (same
f32 math).

Single thread (`RAYON_NUM_THREADS=1` natively, `threads=1` in Chrome):

- River: 15 ms natively.
- Turn, 100 iterations: 7.8 s natively and 10.1 s in wasm (1.3x). The full turn solve
  would take about 19 s on one wasm thread.
- So 8 threads give 3.9x natively and 3.4x in wasm on this 4P+4E chip. A single-thread
  build is a reasonable fallback for river and, on desktop, turn spots. Pool start-up (8 workers) took 50-110 ms, and module init took 25-50 ms.
`WebAssembly.Memory` grew to about 120 MB for the turn spot and 600 MB for the slim
flop.

Build gotchas I hit:

1. **Recent rustc no longer passes the shared-memory linker flags for `+atomics`.**
   Without them the module exports a non-shared memory, and `initThreadPool` throws
   `DataCloneError: #<Memory> could not be cloned`. The fix is to add
   `-C link-arg=--shared-memory --import-memory --export=__wasm_init_tls --export=__tls_size --export=__tls_align --export=__tls_base`
   (see `.cargo/config.toml`).
2. The **wasm-bindgen CLI must match** the crate version exactly (0.2.130 here; the
   installed 0.2.87 was too old).
3. The **`import('../../..')` 404** described in §6.

**Memory64 works end to end in Chrome 156.**

- `cargo build --target wasm64-unknown-unknown -Z build-std` built with the same flags
  (`--max-memory=17179869184`). wasm-bindgen 0.2.130 emitted
  `new WebAssembly.Memory({initial:25n, maximum:262144n, address:'i64', shared:true})`.
- wasm-bindgen-rayon started 8 threads, and every spot gave identical results.
- It was about 10-15% slower than wasm32 on the turn and flop (one run each). That is
  at the low end of SpiderMonkey's 10-100% range.
- `www/grow.html` (`node grow.mjs`) showed a shared wasm32 memory growing to 4 GB and a
  shared memory64 memory growing to the full 16 GB in Chrome 156. The pages were never
  touched, so this works even on this 8 GB machine.
- I didn't run a tree over 4 GB: this machine has 8 GB of RAM.
- Firefox wasn't tested. Safari has no Memory64, so wasm64 can only be an extra tier
  for Chrome/Firefox desktops with 16 GB or more, never the main build.

## 8. Risks

- **Toolchain:** threads need nightly + `build-std`. Pin the nightly. wasm-bindgen
  changes have broken threads before (gotcha 1 above). wasm64 is tier 3.
- **Panics:** the wasm build uses `panic=abort`. `solve.rs`'s `catch_unwind` around
  stage 1 does nothing there, so a crate panic traps the whole module and the worker
  must be re-created. Handle it as "fall back to Fly".
- **Mobile memory:** iOS kills the tab instead of failing an allocation, so a size
  estimate that is too low means a reloaded page with nothing shown. Keep the caps
  conservative and solve compressed on phones.
- **Heat and battery:** a turn solve keeps all cores busy for 5-10 s on a laptop. On phones,
  thermal throttling may double that.
- **Upstream is frozen** (Oct 2023). Any wasm-specific fix means forking.
- **Isolation lock-in:** COOP/COEP limits future embeds, OAuth popups and third-party
  widgets unless each one sends CORP/CORS.
- **Two code paths:** browser and Fly must give the same results. Both use the same
  `solver-core`, so a shared test fixture set is enough.
- **Benchmark noise:** the speed ratios come from a loaded 8 GB M1 (best of 3 rounds;
  single runs varied by up to 2x). Re-measure on a quiet machine and on a phone before
  deciding the per-device routing. Firefox and Safari weren't measured.
