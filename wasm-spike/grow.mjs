// node grow.mjs: opens www/grow.html in headless Chrome and prints how far memory grows.
import { createRequire } from "node:module";
const { chromium } = createRequire("/tmp/pw/")("playwright-core");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log(m.text()));
await page.goto(`http://localhost:${process.env.PORT || 8787}/www/grow.html`);
await page.waitForFunction(() => window.__done, null, { timeout: 60_000 });
await browser.close();
