/**
 * Runs the real app in real Chrome for end-to-end tests: a Vite dev server on
 * a private port and a headless browser driven through playwright-core. The
 * machine's installed Google Chrome is used, so nothing is downloaded.
 */
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

const APP_ROOT = path.join(import.meta.dirname, "../../..");

export const FIXTURE_FONTS = path.join(APP_ROOT, "test/fixtures/fonts");

export const SHOTS_DIR = path.join(APP_ROOT, ".cache/shots");

export interface AppSession {
  close(): Promise<void>;
  /** Messages the page logged as errors, and uncaught exceptions. */
  readonly errors: readonly string[];
  goto(hash: string): Promise<void>;
  readonly page: Page;
  screenshot(name: string, fullPage?: boolean): Promise<string>;
  readonly url: string;
}

export interface AppOptions {
  readonly height?: number;
  readonly port: number;
  readonly width?: number;
}

export const startApp = async ({
  port,
  width = 1440,
  height = 900,
}: AppOptions): Promise<AppSession> => {
  const server: ViteDevServer = await createServer({
    logLevel: "error",
    root: APP_ROOT,
    // No reloading: an edit elsewhere in the checkout would reload the page
    // mid-test and empty the in-memory project.
    server: { hmr: false, port, strictPort: true, watch: null },
  });
  await server.listen();
  const browser: Browser = await chromium.launch({
    channel: "chrome",
    headless: true,
  });
  const page = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: { height, width },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  const url = `http://localhost:${port}/`;
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  return {
    async close() {
      await browser.close();
      await server.close();
    },
    errors,
    async goto(hash) {
      await page.goto(`${url}#${hash}`);
      await page.evaluate(() => document.fonts.ready);
    },
    page,
    async screenshot(name, fullPage = false) {
      const file = path.join(SHOTS_DIR, `${name}.png`);
      await page.screenshot({ fullPage, path: file });
      return file;
    },
    url,
  };
};
