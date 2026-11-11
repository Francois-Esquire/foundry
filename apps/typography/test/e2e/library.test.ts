/**
 * The first milestone, proved in real Chrome: import fonts with different
 * script coverage, browse them in the library, explore their coverage, search
 * for a character and export an original file unchanged.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppSession, FIXTURE_FONTS, startApp } from "./support/app";
import { PORTS } from "./support/ports";

const LATO = "Lato-Regular.ttf";
const SOFIA = "SofiaSans-wght.ttf";
const NOTO = "NotoSansDevanagari-wdth-wght.ttf";
const KA = 'button[aria-label^="U+0915"]';
const SHOT = "library-e2e";

const SHOW_SOFIA = /Show Sofia Sans/;
const SHOW_NOTO = /Show Noto Sans Devanagari/;
const SHOW_LATO = /Show Lato/;
const SOURCE_FAMILY = /^"?Typography Source /;

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Waits until the specimen is set as text in the face's own loaded font. */
const specimenInFont = async (page: Page): Promise<Locator> => {
  const text = page
    .getByRole("region", { name: "Text set in the face" })
    .locator('.ty-face-text[data-setting="font"]');
  await text.waitFor();
  return text;
};

/** Waits until the specimen shows text at all, in the font or drawn from outlines. */
const specimenSet = (page: Page) =>
  page
    .getByRole("region", { name: "Text set in the face" })
    .locator('.ty-face-text:not([data-setting="loading"])')
    .waitFor();

const widthOf = async (locator: Locator) =>
  (await locator.boundingBox())?.width ?? 0;

/** The share a statistics row gives for a writing system, as a number. */
const shareOf = async (page: Page, script: string) => {
  const row = page
    .getByRole("table", { name: "Coverage by writing system" })
    .getByRole("row")
    .filter({
      has: page.getByRole("rowheader", { exact: true, name: script }),
    });
  return Number.parseFloat(await row.getByRole("cell").first().innerText());
};

const chooseFace = (page: Page, label: string) =>
  page.getByRole("combobox", { name: "Face" }).selectOption({ label });

describe("the library, in Chrome", () => {
  let app: AppSession;
  let page: Page;

  beforeAll(async () => {
    app = await startApp({ port: PORTS.library });
    ({ page } = app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("imports three fonts beside a file that is not one, and lists them", async () => {
    const notAFont = path.join(
      await mkdtemp(path.join(tmpdir(), "ty-")),
      "notes.ttf"
    );
    await writeFile(notAFont, "Specimen notes, saved with a font extension.\n");
    await app.goto("/import");
    await page
      .getByLabel("Add font files")
      .setInputFiles([
        notAFont,
        ...[LATO, SOFIA, NOTO].map((file) => path.join(FIXTURE_FONTS, file)),
      ]);
    const sources = page.getByRole("table", { name: "Imported source fonts" });
    const files = sources.locator("tbody tr > td:first-child");
    await expect.poll(() => files.count()).toBe(3);
    expect(await files.allInnerTexts()).toEqual([LATO, SOFIA, NOTO]);
    await page
      .getByText(
        "3 fonts imported. 1 file could not be read, for the reasons given above."
      )
      .waitFor();
    const refusal = page.getByRole("alert").filter({ hasText: "notes.ttf" });
    expect(await refusal.innerText()).toContain("Could not import notes.ttf.");
    await app.screenshot(`${SHOT}-1-import`);
    await refusal.getByRole("button", { name: "Dismiss" }).click();
  });

  it("lists families and faces, and shows the variable faces' axes", async () => {
    await app.goto("/library");
    const faces = page.getByRole("table", { name: "Fonts by family and face" });
    await faces.waitFor();
    const rows = await faces.getByRole("row").allInnerTexts();
    const row = (family: string) =>
      rows.find((text) => text.toUpperCase().startsWith(family.toUpperCase()));
    expect(rows).toHaveLength(4);
    expect(row("Lato")).toContain("Static");
    expect(row("Sofia Sans")).toContain("Variable: Weight 1 to 1000");
    expect(row("Noto Sans Devanagari")).toContain(
      "Variable: Weight 100 to 900, Width 62.5 to 100"
    );

    await page.getByRole("button", { name: SHOW_NOTO }).click();
    await page.getByRole("slider", { name: "Weight" }).waitFor();
    await page.getByRole("slider", { name: "Width" }).waitFor();
    await specimenSet(page);
    await app.screenshot(`${SHOT}-2-library-variable`);

    await page.getByRole("button", { name: SHOW_LATO }).click();
    await page.getByText("Lato-Regular.ttf, 641 kB").waitFor();
    expect(await page.getByRole("slider", { name: "Weight" }).count()).toBe(0);
  });

  it("changes the specimen's rendered width when an axis slider moves", async () => {
    await page.getByRole("button", { name: SHOW_SOFIA }).click();
    await page.getByRole("textbox", { name: "Specimen text" }).fill("Hamburg");
    const specimen = await specimenInFont(page);
    expect(
      await specimen.evaluate((element) => getComputedStyle(element).fontFamily)
    ).toMatch(SOURCE_FAMILY);
    const regular = await widthOf(specimen);
    expect(regular).toBeGreaterThan(0);
    await app.screenshot(`${SHOT}-3-specimen-regular`);

    const weight = page.getByRole("slider", { name: "Weight" });
    await weight.focus();
    await page.keyboard.press("End");
    expect(await weight.inputValue()).toBe("1000");
    await expect.poll(() => widthOf(specimen)).toBeGreaterThan(regular + 2);
    const heavy = await widthOf(specimen);
    await app.screenshot(`${SHOT}-4-specimen-heavy`);

    await page.keyboard.press("Home");
    await expect.poll(() => widthOf(specimen)).toBeLessThan(heavy - 2);
  });

  it("shows no Devanagari in Lato: zero coverage and a crossed box for U+0915", async () => {
    await app.goto("/coverage/Deva");
    await chooseFace(page, "Lato Regular");
    await page.getByRole("link", { name: "Devanagari, 0 of 164" }).waitFor();
    expect(await shareOf(page, "Devanagari")).toBe(0);
    const ka = page.locator(KA);
    expect(await ka.getAttribute("data-state")).toBe("missing");
    expect(await ka.locator(".ty-tofu").count()).toBe(1);
    expect(await ka.locator(".ty-glyph-cell-form").count()).toBe(0);
    await app.screenshot(`${SHOT}-5-coverage-lato`);
  });

  it("shows Devanagari in Noto: coverage above zero and the real glyph for U+0915", async () => {
    await chooseFace(page, "Noto Sans Devanagari Regular");
    await page.getByRole("link", { name: "Devanagari, 164 of 164" }).waitFor();
    expect(await shareOf(page, "Devanagari")).toBe(100);
    const ka = page.locator(KA);
    await ka.locator(".ty-glyph-cell-form").waitFor();
    expect(await ka.getAttribute("data-state")).toBe("source");
    expect(await ka.locator(".ty-tofu").count()).toBe(0);
    const form = ka.locator(".ty-glyph-cell-form");
    expect(await form.innerText()).toBe("क");
    const family = await form.evaluate(
      (element) => getComputedStyle(element).fontFamily
    );
    expect(family).toMatch(SOURCE_FAMILY);
    // The glyph is drawn by the imported font itself, not by a fallback.
    expect(
      await page.evaluate(
        (name) =>
          [...document.fonts].some(
            (font) =>
              font.family.replaceAll('"', "") === name.replaceAll('"', "") &&
              font.status === "loaded"
          ),
        family
      )
    ).toBe(true);

    await ka.click();
    const inspector = page.getByRole("complementary", { name: "Character" });
    await inspector.getByText("DEVANAGARI LETTER KA").waitFor();
    await inspector.getByText("In the source font, unchanged").waitFor();
    await app.screenshot(`${SHOT}-6-coverage-noto`);
  });

  it("finds the character by code point and by words from its name", async () => {
    const field = page.getByRole("searchbox", { name: "Find a character" });
    const results = page.getByRole("region", { name: "Search results" });

    await field.fill("U+0915");
    await results.locator(KA).waitFor();
    expect(await results.getByRole("button").count()).toBe(1);
    await app.screenshot(`${SHOT}-7-search-code-point`);

    await field.fill("devanagari ka");
    await expect
      .poll(() => results.getByRole("button").count())
      .toBeGreaterThan(1);
    expect(
      await results.getByRole("button").first().getAttribute("aria-label")
    ).toContain("U+0915");
    await app.screenshot(`${SHOT}-8-search-name`);
    await field.fill("");
  });

  it("exports the original file byte for byte", async () => {
    await app.goto("/library");
    await page.getByRole("button", { name: SHOW_LATO }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export original" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(LATO);
    const saved = await readFile(await download.path());
    const fixture = await readFile(path.join(FIXTURE_FONTS, LATO));
    expect(sha256(saved)).toBe(sha256(fixture));
    await app.screenshot(`${SHOT}-9-export`);
  });

  it("fits a phone: nothing spills past 390 pixels", async () => {
    await page.setViewportSize({ height: 844, width: 390 });
    for (const place of ["import", "library", "coverage/Deva"]) {
      await app.goto(`/${place}`);
      await page.locator(".ty-app-main > :not(h1)").first().waitFor();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth)
      ).toBeLessThanOrEqual(390);
      await app.screenshot(`${SHOT}-390-${place.replace("/", "-")}`);
    }
    await page.setViewportSize({ height: 900, width: 1440 });
  });

  it("logged no errors along the way", () => {
    expect(app.errors).toEqual([]);
  });
});
