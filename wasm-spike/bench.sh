#!/bin/sh
# Interleaves native and Chrome (wasm) runs ROUNDS times and prints the best solve time
# per spot and build. Needs serve.mjs running and ./build.sh done.
# The machine is shared, so the minimum over rounds is the least-noisy number.
cd "$(dirname "$0")"
ROUNDS=${ROUNDS:-3}
FILTER=${1:-}
SPOTS=${2:-}
out=bench-results.ndjson; : > $out
for i in $(seq $ROUNDS); do
  ./target/release/native "$FILTER" $SPOTS | sed 's/^{/{"build":"native",/' >> $out
  ./target/alloc/release/native "$FILTER" $SPOTS | sed 's/^{/{"build":"native+alloc",/' >> $out
  for p in pkg pkg-alloc; do
    TIMEOUT_MS=900000 node run.mjs $p "$FILTER" "" "${SPOTS:+../$SPOTS}" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s).results)console.log(JSON.stringify({build:"wasm:"+process.argv[1],...r}))})' $p >> $out
  done
done
python3 - $out <<'PY'
import json,sys
best={}
for l in open(sys.argv[1]):
    r=json.loads(l); k=(r["name"],r["build"])
    if k not in best or r["solve_ms"]<best[k]["solve_ms"]: best[k]=r
for (n,b),r in sorted(best.items()):
    print(f'{n:34s} {b:13s} it={r["iterations"]:4d} solve={r["solve_ms"]:9.0f}ms  {r["ms_per_iter"]:8.1f}ms/it  expl={r["exploitability_pct"] or 0:.3f}%  mem={r.get("wasm_memory_mb") or r["raw_mb"]:.0f}MB')
PY
