// Static server with the cross-origin isolation headers SharedArrayBuffer needs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const port = +(process.env.PORT || 8787);

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  // wasm-bindgen-rayon's workerHelpers.js does `import('../../..')`, i.e. the pkg directory;
  // without a bundler the server has to answer that with the package's main JS file.
  const dirIndex = /^\/pkg[^/]*\/$/.test(path) ? "wasm_spike.js" : "index.html";
  const file = join(root, path.endsWith("/") ? path + dirIndex : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`http://localhost:${port}/www/`));
