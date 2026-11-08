// Module worker: loads the threaded wasm build, starts the rayon pool (one Web Worker per
// thread, sharing one WebAssembly.Memory), then runs spots and streams progress back.
let mod;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      const t0 = performance.now();
      mod = await import(`../${data.pkg}/wasm_spike.js`);
      await mod.default();
      const tInit = performance.now() - t0;
      await mod.initThreadPool(data.threads);
      self.postMessage({ type: "ready", init_ms: tInit, pool_ms: performance.now() - t0 - tInit,
                         spots: JSON.parse(mod.spots()) });
    } else if (data.type === "solve") {
      const json = mod.solve_spot(JSON.stringify(data.spot), (iter, expl, ms) =>
        self.postMessage({ type: "progress", name: data.spot.name, iter, expl, ms }));
      const report = JSON.parse(json);
      report.wasm_memory_mb = mod.memory_mb ? mod.memory_mb() : null;
      self.postMessage({ type: "result", report });
    }
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.stack || e) });
  }
};
