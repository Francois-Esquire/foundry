/**
 * The worker engine in real Chrome: a Vite dev server serves a page that
 * builds derived fonts through the engine client, and Chrome's own font
 * pipeline (which runs the OpenType Sanitizer) has to accept the results.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DerivedFontReport } from "~/packaging/validation";
import type { PageResult } from "./engine-page";

const APP_ROOT = path.join(import.meta.dirname, "../../..");
const PORT = 5314;
const PAGE = `http://localhost:${PORT}/test/integration/packaging/engine-page.html`;
/** The page rebuilds a variable font, which takes the engine most of a minute. */
const PAGE_TIMEOUT = 240_000;

const outcomes = (report: DerivedFontReport) =>
  Object.fromEntries(report.checks.map((check) => [check.id, check.outcome]));

describe("the font engine in Chrome", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let result: PageResult;
  const consoleErrors: string[] = [];

  beforeAll(async () => {
    server = await createServer({
      // Other work in this checkout must not reload or re-optimise the page mid-run.
      cacheDir: path.join(tmpdir(), "typography-engine-check-vite"),
      configFile: path.join(APP_ROOT, "vite.config.ts"),
      logLevel: "error",
      optimizeDeps: { noDiscovery: true },
      root: APP_ROOT,
      server: { hmr: false, port: PORT, strictPort: true, watch: null },
    });
    await server.listen();
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) {
        consoleErrors.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto(PAGE);
    await page.waitForFunction(
      () => document.body.dataset.state !== "running",
      undefined,
      { timeout: PAGE_TIMEOUT }
    );
    const state = await page.evaluate(() => document.body.dataset.state);
    const text = await page.locator("#result").textContent();
    if (state !== "done") {
      throw new Error(
        `The engine page failed: ${text}\n${consoleErrors.join("\n")}`
      );
    }
    result = JSON.parse(text ?? "{}") as PageResult;
    console.info("Engine timings in Chrome (ms):", result.timings);
    console.info("Variable font build in Chrome (ms):", {
      ...result.variable.timings,
      roundTripMs: result.variable.roundTripMs,
    });
  }, PAGE_TIMEOUT + 30_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("starts lazily and reports its status", () => {
    expect(result.statuses).toEqual(["idle", "starting", "ready"]);
    expect(consoleErrors).toEqual([]);
  });

  it("answers calls queued before the engine was ready", () => {
    expect(result.ttf.signature).toEqual([0, 1, 0, 0]);
    expect(result.ttf.characters).toBe(3);
    expect(result.woff2.signature).toBe("wOF2");
    expect(result.woff2.bytes).toBeLessThan(result.ttf.bytes);
    expect(result.layoutGlyphs).toBe(3023);
  });

  it("copies the caller's bytes instead of taking them", () => {
    expect(result.sourceBytesAfterBuild).toBe(656_568);
  });

  it("has its fonts accepted and drawn by Chrome", () => {
    // Three added glyphs, each 1000 units wide in a 2000 unit em, at 100px.
    expect(result.ttf.width).toBeCloseTo(150, 0);
    expect(result.woff2.width).toBeCloseTo(150, 0);
  });

  it("validates a built font inside the worker", () => {
    expect(result.validation.issues).toEqual([]);
    expect(result.validation.loadable).toBe(true);
  });

  it("validates derived fonts in the page, with Chrome as the browser check", () => {
    const allPass = {
      browser: "pass",
      coverage: "pass",
      engine: "pass",
      joining: "pass",
      reopen: "pass",
      shaping: "pass",
    };
    expect(outcomes(result.ttf.report)).toEqual(allPass);
    expect(outcomes(result.woff2.report)).toEqual(allPass);
    expect(result.ttf.report.passed).toBe(true);
  });

  it("has Chrome refuse a font that was cut short", () => {
    expect(result.damagedReport.passed).toBe(false);
    expect(outcomes(result.damagedReport)).toMatchObject({
      browser: "fail",
      engine: "fail",
    });
  });

  describe("a variable font rebuilt from three generated masters", () => {
    it("is built in the worker and passes the engine's validation", () => {
      expect(result.variable.compatible).toBe(true);
      expect(result.variable.axis).toEqual({
        default: 400,
        max: 800,
        min: 300,
        name: "Weight",
        tag: "wght",
      });
      // Sofia Sans has 954 glyphs, and six accented letters were added.
      expect(result.variable.glyphCount).toBe(960);
      expect(result.variable.validation.issues).toEqual([]);
      expect(result.variable.validation.loadable).toBe(true);
      expect(result.variable.sourceBytesAfterBuild).toBeGreaterThan(100_000);
      expect(result.variable.timings.totalMs).toBeLessThanOrEqual(
        result.variable.roundTripMs
      );
    });

    it("is loaded by Chrome and set at the masters and between them", () => {
      const { rendered } = result.variable;
      expect(rendered.map((sample) => sample.weight)).toEqual([
        300, 350, 400, 600, 800,
      ]);
      for (const sample of rendered) {
        // Chrome's line and the font's own advances at that weight agree.
        expect(Math.abs(sample.width - sample.expectedWidth)).toBeLessThan(1);
      }
      const widths = rendered.map((sample) => sample.width);
      expect(widths).toEqual(widths.toSorted((a, b) => a - b));
      expect(new Set(widths.map((width) => width.toFixed(1))).size).toBe(5);
    });

    it("is drawn heavier by Chrome as the weight goes up, also between masters", () => {
      const inks = result.variable.rendered.map((sample) => sample.ink);
      expect(inks[0]).toBeGreaterThan(1000);
      for (const [index, ink] of inks.entries()) {
        if (index > 0) {
          expect(ink).toBeGreaterThan((inks[index - 1] ?? 0) * 1.03);
        }
      }
    });
  });

  describe("a blank source font", () => {
    it("is made in the worker and accepted by Chrome", () => {
      expect(result.blank.blankGlyphs).toBe(2);
      expect(result.blank.blankBytes).toBeLessThan(2000);
      expect(result.blank.validation.issues).toEqual([]);
    });

    it("takes a glyph through a normal build, and Chrome draws it", () => {
      expect(result.blank.filledGlyphs).toBe(3);
      // Three added glyphs, each 1000 units wide in a 1000 unit em, at 100px.
      expect(result.blank.width).toBeCloseTo(300, 0);
    });
  });

  it("raises a BuildError with the engine's message", () => {
    expect(result.failure?.name).toBe("BuildError");
    expect(result.failure?.message).toBe(
      "The source file does not open as a font: Not a TrueType or OpenType font (not enough data)"
    );
  });
});
