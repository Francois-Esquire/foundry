/**
 * Walks the running app and photographs every place, for looking at the whole
 * product in one go. It loads the sample fonts through the Import place, then
 * visits each place at a desktop and a phone width.
 *
 * Usage, from apps/typography:
 *   bun scripts/tour.ts [--port 5399] [--out .cache/shots/tour] [--theme black]
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const PLACES = [
  "import",
  "library",
  "coverage",
  "studio",
  "generate",
  "reconstruct",
  "proof",
  "export",
];
const WIDTHS = [1440, 390];
const SAMPLES_READY_MS = 30_000;

const { values } = parseArgs({
  options: {
    out: { default: ".cache/shots/tour", type: "string" },
    port: { default: "5399", type: "string" },
    theme: { default: "white", type: "string" },
  },
});
const root = path.join(import.meta.dirname, "..");
const outDir = path.resolve(root, values.out);
await mkdir(outDir, { recursive: true });

const server = await createServer({
  logLevel: "error",
  root,
  server: { port: Number(values.port), strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const url = `http://localhost:${values.port}/`;
const problems: string[] = [];

try {
  for (const width of WIDTHS) {
    const page = await browser.newPage({
      deviceScaleFactor: 2,
      viewport: { height: 900, width },
    });
    page.on("pageerror", (error) =>
      problems.push(`${width}: ${error.message}`)
    );
    await page.goto(`${url}#/import`);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, values.theme);
    const samples = page.getByRole("button", { name: /sample/i }).first();
    // The screen loads lazily and fetches the sample list before it offers them.
    await samples.waitFor({ timeout: SAMPLES_READY_MS }).catch(() => undefined);
    if (await samples.count()) {
      await samples.click();
      await page
        .waitForFunction(
          () => {
            const status =
              document
                .querySelector(".ty-masthead-status")
                ?.textContent?.toLowerCase() ?? "";
            return status.includes("font") && !status.includes("no fonts");
          },
          undefined,
          {
            timeout: SAMPLES_READY_MS,
          }
        )
        .catch(() => problems.push(`${width}: the sample fonts did not load`));
    } else {
      problems.push(`${width}: the Import place offers no sample fonts`);
    }
    for (const place of PLACES) {
      await page.goto(`${url}#/${place}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      const file = path.join(outDir, `${place}-${width}-${values.theme}.png`);
      await page.screenshot({ path: file });
      const text = (await page.locator("main").innerText())
        .replaceAll(/\s+/g, " ")
        .slice(0, 90);
      console.log(`${place.padEnd(12)} ${String(width).padEnd(5)} ${text}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (problems.length > 0) {
  console.log(`\nProblems:\n${problems.join("\n")}`);
}
