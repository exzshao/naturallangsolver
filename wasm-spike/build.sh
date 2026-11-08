#!/bin/sh
# Builds the threaded+SIMD wasm32 package into pkg/ (default allocator) and pkg-alloc/
# (postflop-solver custom-alloc), a memory64 build into pkg64/, plus the native baselines. Needs nightly + rust-src and
# wasm-bindgen-cli matching Cargo.lock (0.2.130): WASM_BINDGEN=/path/to/wasm-bindgen.
set -e
cd "$(dirname "$0")"
WB=${WASM_BINDGEN:-/tmp/wbg-0.2.130/bin/wasm-bindgen}
T=wasm32-unknown-unknown
build() { # $1 out dir, $2 cargo features, $3 target (default wasm32)
  t=${3:-$T}
  cargo build --release --lib --target $t -Z build-std=panic_abort,std $2
  $WB --target web --out-dir "$1" target/$t/release/wasm_spike.wasm
  ls -l "$1"/wasm_spike_bg.wasm
}
build pkg ""
build pkg-alloc "--features custom-alloc"
build pkg64 "--features custom-alloc" wasm64-unknown-unknown   # memory64 (Chrome/Firefox only)
cargo build --release --bin native
cargo build --release --bin native --features custom-alloc --target-dir target/alloc
