// Drives installed Chrome headless through www/index.html and prints the reports.
// node run.mjs [pkg] [filter] [threads] [spots-url]   (needs serve.mjs running; playwright-core from /tmp/pw)
import { createRequire } from "node:module";
const require = createRequire("/tmp/pw/");
const { chromium } = require("playwright-core");

const [pkg = "pkg", filter = "", threads = "", spots = ""] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("console", (m) => process.stderr.write(m.text() + "\n"));
const url = `http://localhost:${process.env.PORT || 8787}/www/?pkg=${pkg}&filter=${encodeURIComponent(filter)}${threads ? `&threads=${threads}` : ""}${spots ? `&spots=${spots}` : ""}`;
await page.goto(url);
await page.waitForFunction(() => window.__done, null, { timeout: +(process.env.TIMEOUT_MS || 600_000), polling: 500 });
const out = await page.evaluate(() => ({ results: window.__results, error: window.__error, ua: navigator.userAgent }));
console.log(JSON.stringify(out, null, 1));
await browser.close();
