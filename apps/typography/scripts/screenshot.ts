/**
 * Takes a PNG screenshot of a page in headless Google Chrome, at twice the
 * CSS pixel density, once its fonts have loaded and the network is quiet.
 *
 * Usage:
 *   bun scripts/screenshot.ts <url> <output.png> [options]
 *
 * Options:
 *   --width <px>      Viewport width in CSS pixels. Default 1440.
 *   --height <px>     Viewport height in CSS pixels. Default 900, at most 8192.
 *   --full-page       Capture the whole page instead of the viewport.
 *   --scroll <px>     Scroll down this far before capturing. Default 0.
 *   --theme <name>    "white" or "black". Left out, the page decides.
 *
 * Example, with the dev server on port 5311:
 *   bun scripts/screenshot.ts "http://localhost:5311/#/system" \
 *     .cache/shots/system.png --width 390 --height 844 --theme black
 *
 * The app's screen area scrolls inside the shell, so --full-page there
 * captures one viewport. Pass a tall --height to see a whole screen. Chrome
 * repeats the picture past 16384 device pixels, which is 8192 CSS pixels at
 * this density, so capture a longer screen in parts with --scroll.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { THEME_STORAGE_KEY } from "../src/ui/theme";

const USAGE =
  "Usage: bun scripts/screenshot.ts <url> <output.png> [--width 1440] [--height 900] [--full-page] [--scroll 0] [--theme white|black]";

/** Chrome's largest capture is 16384 device pixels; the density is 2. */
const MAX_HEIGHT = 8192;

const fail = (problem: string): never => {
  console.error(`${problem}\n${USAGE}`);
  process.exit(1);
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  args: process.argv.slice(2),
  options: {
    "full-page": { default: false, type: "boolean" },
    height: { default: "900", type: "string" },
    scroll: { default: "0", type: "string" },
    theme: { type: "string" },
    width: { default: "1440", type: "string" },
  },
});

const [url, output] = positionals;
if (!(url && output) || positionals.length > 2) {
  fail("Give one URL and one output path.");
}

const pixels = (name: "height" | "width") => {
  const size = Number(values[name]);
  return Number.isInteger(size) && size > 0
    ? size
    : fail(`--${name} must be a whole number of pixels above zero.`);
};

const height = pixels("height");
if (height > MAX_HEIGHT) {
  fail(
    `--height can be at most ${MAX_HEIGHT}. Capture a longer screen in parts with --scroll.`
  );
}

const scroll = Number(values.scroll);
if (!(Number.isInteger(scroll) && scroll >= 0)) {
  fail("--scroll must be a whole number of pixels, zero or more.");
}

const { theme } = values;
if (theme !== undefined && theme !== "white" && theme !== "black") {
  fail('--theme must be "white" or "black".');
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    colorScheme: theme === "black" ? "dark" : "light",
    deviceScaleFactor: 2,
    viewport: { height, width: pixels("width") },
  });
  if (theme) {
    // The app reads its theme from storage before the first paint.
    await context.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          // Pages without storage keep their own theme.
        }
      },
      [THEME_STORAGE_KEY, theme] as const
    );
  }
  const page = await context.newPage();
  await page.goto(String(url), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  if (scroll > 0) {
    // The app scrolls its screen area; other pages scroll the window.
    await page.evaluate((top) => {
      window.scrollTo({ top });
      document.querySelector("main")?.scrollTo({ top });
    }, scroll);
  }
  await mkdir(path.dirname(path.resolve(String(output))), { recursive: true });
  await page.screenshot({
    fullPage: values["full-page"],
    path: String(output),
    type: "png",
  });
  console.log(`Wrote ${output}`);
} finally {
  await browser.close();
}
