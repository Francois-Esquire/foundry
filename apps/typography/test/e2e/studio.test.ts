/**
 * The Studio's acceptance, in the real app in Chrome: with Lato loaded, open
 * the glyph for a, move a node with the keyboard, change the advance in the
 * measure table, and see the specimen follow, the history grow by two, undo
 * restore the width, and the original still export byte for byte.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppSession, FIXTURE_FONTS, startApp } from "./support/app";
import { PORTS } from "./support/ports";

const LATO = path.join(FIXTURE_FONTS, "Lato-Regular.ttf");
const NEW_ADVANCE = 1300;
/** Starting Vite and Chrome cold takes longer than a hook is given by default. */
const START_TIMEOUT_MS = 60_000;
const LATIN_SMALL_A = /U\+0061 LATIN SMALL LETTER A/;
const MOVE_IN_PROGRESS = /Move 1 point of .+in progress/;

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The specimen line's width, in font units and in pixels on screen. */
const specimenWidth = async (page: Page) => {
  const line = page.locator("svg.ty-studio-specimen-line");
  const units = Number(await line.getAttribute("data-width-units"));
  const box = await line.boundingBox();
  return { pixels: box?.width ?? 0, units };
};

const revisionCount = async (revisions: Locator) => ({
  head: Number(await revisions.getAttribute("data-head")),
  recorded: Number(await revisions.getAttribute("data-revisions")),
});

/** Imports Lato through the Import place, then opens the Studio from the strip. */
const openStudioWithLato = async (page: Page) => {
  const places = page.getByRole("navigation", { name: "Places" });
  await places.getByRole("link", { name: "Import" }).click();
  await page.locator('input[type="file"]').setInputFiles(LATO);
  await page
    .getByRole("cell", { exact: true, name: "Lato-Regular.ttf" })
    .first()
    .waitFor();
  await places.getByRole("link", { name: "Studio" }).click();
};

describe("the Studio in Chrome", () => {
  let app: AppSession;

  beforeAll(async () => {
    app = await startApp({ port: PORTS.studio });
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  it("edits a glyph of Lato, shows it in text, undoes it and exports the original", async () => {
    const { page } = app;
    await openStudioWithLato(page);
    const drawing = page.getByRole("application");
    await drawing.waitFor();
    await app.screenshot("studio-e2e-1-opened");

    // Open the glyph for a, by its character.
    await page.getByRole("searchbox", { name: "Find a glyph" }).fill("a");
    await page.getByRole("searchbox", { name: "Find a glyph" }).press("Enter");
    await page.getByText(LATIN_SMALL_A).waitFor();
    await page.getByRole("textbox", { name: "Specimen text" }).fill("banana");
    const inspector = page.getByRole("complementary", {
      name: "Measures and revisions",
    });
    const revisions = inspector.locator("ol.ty-studio-revisions");
    const before = await specimenWidth(page);
    const startedWith = await revisionCount(revisions);
    const advance = inspector.getByRole("textbox", {
      name: "Advance, in font units",
    });
    const sourceAdvance = Number(await advance.inputValue());
    expect(before.units).toBeGreaterThan(0);
    expect(sourceAdvance).not.toBe(NEW_ADVANCE);
    await app.screenshot("studio-e2e-2-glyph-a");

    // Move a node with the keyboard: one run of nudges, shown before it is recorded.
    const outlineBefore = await page
      .locator("path.ty-studio-edit")
      .getAttribute("d");
    await drawing.focus();
    await page.keyboard.press("PageDown");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ArrowUp");
    await inspector.getByText(MOVE_IN_PROGRESS).waitFor();
    expect(
      await page.locator("path.ty-studio-edit").getAttribute("d")
    ).not.toBe(outlineBefore);
    expect(await revisionCount(revisions)).toEqual(startedWith);
    await app.screenshot("studio-e2e-3-node-moved");

    // Change the advance in the measure table.
    await advance.fill(String(NEW_ADVANCE));
    await advance.press("Enter");
    await expect
      .poll(() => revisionCount(revisions))
      .toEqual({
        head: startedWith.head + 2,
        recorded: startedWith.recorded + 2,
      });
    const widened = await specimenWidth(page);
    // "banana" holds three of the glyph.
    expect(widened.units).toBe(
      before.units + 3 * (NEW_ADVANCE - sourceAdvance)
    );
    expect(widened.pixels).toBeGreaterThan(before.pixels + 1);
    await app.screenshot("studio-e2e-4-advance-changed");

    // Undo restores the width.
    await inspector.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => specimenWidth(page)).toEqual(before);
    expect((await revisionCount(revisions)).head).toBe(startedWith.head + 1);
    await app.screenshot("studio-e2e-5-undone");

    // With the edits applied again, the original still exports untouched.
    await inspector.getByRole("button", { name: "Redo" }).click();
    await expect.poll(() => specimenWidth(page)).toEqual(widened);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      inspector.getByRole("button", { name: "Export original" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("Lato-Regular.ttf");
    const saved = readFileSync(await download.path());
    expect(sha256(saved)).toBe(sha256(readFileSync(LATO)));
    await app.screenshot("studio-e2e-6-exported");

    expect(app.errors).toEqual([]);
  });
});
