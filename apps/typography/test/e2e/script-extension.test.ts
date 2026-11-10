/**
 * The script extension's acceptance, in the real app in Chrome. With Lato
 * loaded through the Import place: the extension is opened from Generate,
 * replayed from the recorded run, looked at, added to the face as one
 * revision and verified in a font the engine builds. A derived font is then
 * exported under a new family name, and the downloaded bytes are reopened
 * here to check that the planned words shape and Latin still does. Undo
 * takes the characters out of the face again.
 *
 * Nothing here calls a model. The recorded sheets are real saved output.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import { type AppSession, FIXTURE_FONTS, startApp } from "./support/app";

const PORT = 5338;
const LATO = path.join(FIXTURE_FONTS, "Lato-Regular.ttf");
const MODEL = "ideogram/vector/text-to-vector";
const FAMILY = "Atlas Sans";
const EXPORTED_FILE = "AtlasSans-Regular.ttf";
const BUILD_TIMEOUT = 150_000;
const SETTLE_MS = 250;
const WIDE = { height: 900, width: 1440 };
const NARROW = { height: 2600, width: 390 };

const SCOPE =
  "This is a defined subset: 15 characters, 3 forms with no character of their own, and 9 test words. It is not support for Devanagari.";
const RECORDED = "Recorded run, replayed. Not live model output";
const NO_REVISIONS = /1 font, 0 revisions/;
const ONE_REVISION = /1 font, 1 revision\b/;
const BUILD = /^Build \d+ fonts?$/;
const SUPPORTS = /supports (Devanagari|Hindi)/i;
const SEPARATED = /Separated from the generated syllable/;
const WEIGHT =
  /Headline thickness of the new letters: \d+ units, against \d+ for the face's level strokes/;
const NAMASTE = "नमस्ते";
const SITAR = "सितार";

const section = (page: Page, name: string) =>
  page.getByRole("region", { exact: true, name });

const glyphCells = (page: Page) => page.locator("li.ty-extension-glyph");

/** How each glyph on the board stands, read from the board itself. */
const standings = (page: Page) =>
  glyphCells(page).evaluateAll((cells) =>
    cells.map((cell) => cell.getAttribute("data-standing") ?? "")
  );

const charactersInFace = (page: Page) =>
  page
    .locator("[data-characters-in-face]")
    .getAttribute("data-characters-in-face");

describe("a script extension in Chrome", () => {
  let app: AppSession;
  let page: Page;
  let places: Locator;
  let downloads: string;

  /** Changes the viewport and waits for the page to be drawn at the new size. */
  const resize = async (size: { height: number; width: number }) => {
    await page.setViewportSize(size);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    );
    await page.waitForTimeout(SETTLE_MS);
  };

  /** A picture at one size, from the top of a part of the screen, then back to the working size. */
  const shoot = async (
    name: string,
    size: { height: number; width: number },
    from?: Locator
  ) => {
    await resize(size);
    if (from) {
      await from.evaluate((element) =>
        element.scrollIntoView({ block: "start" })
      );
    } else {
      await page.locator("main").evaluate((main) => main.scrollTo({ top: 0 }));
    }
    await page.waitForTimeout(SETTLE_MS);
    await app.screenshot(`script-extension-e2e-${name}`);
    await resize(WIDE);
  };

  beforeAll(async () => {
    downloads = await mkdtemp(path.join(tmpdir(), "typography-extension-"));
    app = await startApp({ port: PORT, ...WIDE });
    ({ page } = app);
    places = page.getByRole("navigation", { name: "Places" });
    await places.getByRole("link", { name: "Import" }).click();
    await page.getByLabel("Add font files").setInputFiles(LATO);
    await page
      .getByRole("cell", { name: "Lato-Regular.ttf" })
      .first()
      .waitFor();
  });

  afterAll(async () => {
    await app.close();
    await rm(downloads, { force: true, recursive: true });
  });

  it("offers the extension in Generate and states its scope before anything runs", async () => {
    await places.getByRole("link", { name: "Generate" }).click();
    const offer = page.locator("output").filter({ hasText: "on offer" });
    await offer.waitFor();
    expect(await offer.innerText()).toContain(SCOPE);
    await shoot("1-offer", WIDE);

    await offer
      .getByRole("link", { name: "Open the script extension" })
      .click();
    await section(page, "Script extension").waitFor();
    expect(new URL(page.url()).hash).toBe("#/generate/script-extension");
    expect(await page.locator("[data-extension-scope]").innerText()).toBe(
      SCOPE
    );
    expect(await charactersInFace(page)).toBe("0");

    // The plan: every glyph with its character or its rule, and the test words.
    const planned = section(page, "Plan");
    const glyphs = planned.getByRole("table", {
      name: "Planned glyphs, each with its character or its rule",
    });
    expect(await glyphs.locator("tbody tr").count()).toBe(18);
    expect(await glyphs.innerText()).toContain("The akhn feature");
    const words = planned.getByRole("table", {
      name: "Test words and the glyph sequence each must shape to",
    });
    expect(await words.locator("tbody tr").count()).toBe(9);
    expect(await words.innerText()).toContain(
      "na-deva ma-deva sa-deva.half ta-deva eMatra-deva"
    );

    // The source is the recorded run, named as such, with its model.
    const run = section(page, "Run");
    const source = run.locator("[data-extension-source]");
    await source.waitFor();
    expect(await source.innerText()).toContain(RECORDED);
    expect(await source.innerText()).toContain(MODEL);
    expect(await run.innerText()).toContain(
      "A model strategy is not offered here."
    );
    expect(await section(page, "Result").count()).toBe(0);
    await shoot("2-scope-and-plan", { height: 2400, width: 1440 });
    expect(app.errors).toEqual([]);
  });

  it("replays the recorded run and shows every glyph before anything enters the face", async () => {
    const run = section(page, "Run");
    // From the keyboard: the control takes focus and Enter starts the run.
    await run.getByRole("button", { name: "Replay the recorded run" }).focus();
    await page.keyboard.press("Enter");
    const summary = page.locator("[data-extension-result]");
    await summary.waitFor();
    expect(await summary.getAttribute("data-glyphs")).toBe("18");
    expect(await summary.getAttribute("data-mapped")).toBe("15");
    expect(await summary.getAttribute("data-forms")).toBe("3");
    expect(await summary.getAttribute("data-missing")).toBe("0");
    expect(await summary.innerText()).toContain(
      "18 of 18 planned glyphs made: 15 with a character, 3 forms with no character. 0 not made."
    );
    expect(await summary.innerText()).toContain("not a live model answer");

    // Every step of the run ended, and each says what it came to.
    const steps = run.getByRole("list", { name: "Steps of the run" });
    expect(
      await steps
        .locator("li")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-status") ?? "")
        )
    ).toEqual(["finished", "finished", "finished", "finished"]);
    expect(await steps.innerText()).toContain(
      "6 cells the plan does not list were set aside."
    );

    // Eighteen glyphs, each in the dotted frame of generated work, none in the face.
    expect(await glyphCells(page).count()).toBe(18);
    expect(new Set(await standings(page))).toEqual(new Set(["generated"]));
    expect(
      await page.locator('.ty-generate-frame[data-status="proposed"]').count()
    ).toBe(18);
    const result = section(page, "Result");
    expect(await result.innerText()).toContain(RECORDED);
    expect(await result.innerText()).toContain(MODEL);
    const vowelSign = page.locator('li[data-glyph="iMatra-deva"]');
    expect(await vowelSign.innerText()).toMatch(SEPARATED);
    expect(
      await vowelSign.locator("[data-verdict]").getAttribute("data-verdict")
    ).toBe("review");
    expect(
      await page
        .locator('li[data-glyph="ka-deva"] [data-verdict]')
        .getAttribute("data-verdict")
    ).toBe("pass");
    expect(await page.locator("[data-extension-weight]").innerText()).toMatch(
      WEIGHT
    );

    // Nothing has entered the face, and there is no way to take part of it.
    expect(await page.getByText(NO_REVISIONS).count()).toBe(1);
    expect(await charactersInFace(page)).toBe("0");
    expect(await result.getByRole("button").count()).toBe(0);
    expect(await section(page, "Add to the face").innerText()).toContain(
      "There is no way to add only some of it"
    );
    await shoot("3-result", { height: 4200, width: 1440 }, result);
    await shoot("3-result-390", NARROW, result);
    // Nothing is wider than a phone.
    await resize(NARROW);
    expect(
      await page.evaluate(() => {
        const main = document.querySelector("main");
        return main ? main.scrollWidth <= main.clientWidth : false;
      })
    ).toBe(true);
    await resize(WIDE);
    expect(app.errors).toEqual([]);
  });

  it("adds the whole extension as one revision, and the glyphs read as accepted", async () => {
    const add = section(page, "Add to the face");
    await add
      .getByRole("button", { name: "Add the whole extension to Lato Regular" })
      .click();
    await page.getByText(ONE_REVISION).waitFor();
    expect(new Set(await standings(page))).toEqual(new Set(["accepted"]));
    expect(
      await page.locator('.ty-generate-frame[data-status="proposed"]').count()
    ).toBe(0);
    expect(await charactersInFace(page)).toBe("15");
    expect(await add.innerText()).toContain("In the face as one revision");
    await shoot("4-added", { height: 1500, width: 1440 }, add);
    expect(app.errors).toEqual([]);
  });

  it("verifies the built font: nine of nine test words, and no check that did not run reads as passed", async () => {
    const verification = section(page, "Verification");
    await verification
      .getByRole("button", { name: "Build and verify" })
      .click();
    const verdict = page.locator("[data-extension-verification]");
    await verdict.waitFor({ timeout: BUILD_TIMEOUT });
    expect(await verdict.getAttribute("data-extension-verification")).toBe(
      "pass"
    );
    expect(await verdict.getAttribute("data-words-passed")).toBe("9");
    expect(await verdict.getAttribute("data-words")).toBe("9");
    // textContent, since the stylesheet prints a label in capitals.
    expect(await verification.textContent()).toContain(
      "Test words: 9 of 9 shape to the planned glyphs"
    );

    // The checks with their counts. Only Lato is in the project, so letter
    // identity had nothing to compare with: it did not run and says so.
    const checks = verification.getByRole("table", {
      name: "Checks of the built font, with how many items of each passed",
    });
    const rows = await checks.locator("tbody tr").evaluateAll((trs) =>
      trs.map((row) => ({
        counted: row.children[1]?.textContent?.trim() ?? "",
        name: row.children[0]?.textContent?.trim() ?? "",
        outcome:
          row.querySelector("[data-outcome]")?.getAttribute("data-outcome") ??
          "",
      }))
    );
    expect(rows.map((row) => [row.counted, row.outcome])).toEqual([
      ["", "pass"],
      ["15 of 15", "pass"],
      ["3 of 3", "pass"],
      ["9 of 9", "pass"],
      ["3 of 3", "pass"],
      ["9 of 9", "pass"],
      ["", "not-run"],
      ["4 of 4", "pass"],
    ]);
    expect(rows[6]?.name).toBe("Letter identity");
    expect(await verification.innerText()).toContain(
      "1 check did not run and is not counted as passed."
    );

    // Each test word in the built font's own outlines, with what it shaped to.
    const words = verification.getByRole("list", {
      name: "Test words in the built font's own outlines",
    });
    expect(await words.locator('li[data-pass="true"]').count()).toBe(9);
    expect(await words.locator("svg path").count()).toBeGreaterThan(27);
    expect(await words.locator('li[data-word="1"]').innerText()).toContain(
      "na-deva ma-deva sa-deva.half ta-deva eMatra-deva"
    );

    // The report's own list of what was not verified, in full.
    const notVerified = page.locator("[data-extension-not-verified]");
    expect(await notVerified.getAttribute("data-extension-not-verified")).toBe(
      "7"
    );
    expect(await notVerified.locator("li").count()).toBe(7);
    expect(await notVerified.innerText()).toContain(
      "This is not support for Devanagari or for a language written in it."
    );
    expect(await notVerified.innerText()).toContain(
      "Letter identity. No reference face was given"
    );

    // Nowhere does the screen claim the script or a language is supported.
    expect(await page.locator("main").innerText()).not.toMatch(SUPPORTS);
    await shoot("5-verification", { height: 2600, width: 1440 }, verification);
    await shoot(
      "5-verification-390",
      { height: 4200, width: 390 },
      verification
    );
    expect(app.errors).toEqual([]);
  });

  it("exports a derived font under a new family name that shapes the planned words", async () => {
    await section(page, "Next")
      .getByRole("link", { name: "Plan an export" })
      .click();
    await section(page, "Faces").waitFor();
    await page.getByLabel("Family name").fill(FAMILY);
    const planSection = section(page, "Plan");
    await expect.poll(() => planSection.innerText()).toContain(EXPORTED_FILE);
    await planSection.getByRole("button", { name: BUILD }).click();
    const built = page
      .getByTestId("built-font")
      .filter({ has: page.getByRole("heading", { name: EXPORTED_FILE }) });
    await built.waitFor({ timeout: BUILD_TIMEOUT });
    // Export's own report on the file, as that place words it.
    expect(await built.innerText()).toContain("6 of 6 checks passed");
    await shoot("6-export", { height: 3200, width: 1440 });

    const [saved] = await Promise.all([
      page.waitForEvent("download"),
      built.getByRole("button", { name: `Download ${EXPORTED_FILE}` }).click(),
    ]);
    const file = path.join(downloads, saved.suggestedFilename());
    await saved.saveAs(file);
    expect(path.basename(file)).toBe(EXPORTED_FILE);

    const source = harfBuzzReader.open(new Uint8Array(await readFile(LATO)));
    const derived = harfBuzzReader.open(new Uint8Array(await readFile(file)));
    try {
      // The engine appends added glyphs in plan order after the source font's own.
      const firstAdded = source.description.glyphCount;
      const shaped = (text: string) =>
        derived
          .shape(text, { script: plan.iso15924 })
          .glyphs.map(
            (glyph) =>
              plan.glyphs[glyph.glyphId - firstAdded]?.name ??
              `source:${glyph.glyphId}`
          );
      const planned = (text: string) =>
        plan.words.find((word) => word.text === text)?.glyphs;

      expect(derived.description.familyName).toBe(FAMILY);
      expect(derived.description.glyphCount).toBe(firstAdded + 18);
      expect(shaped(NAMASTE)).toEqual(planned(NAMASTE));
      expect(shaped(NAMASTE)).toEqual([
        "na-deva",
        "ma-deva",
        "sa-deva.half",
        "ta-deva",
        "eMatra-deva",
      ]);
      // The vowel sign follows स in the text and is set before it.
      expect(shaped(SITAR)[0]).toBe("iMatra-deva");
      expect(shaped(SITAR)).toEqual(planned(SITAR));
      // Latin is as it was: f and i still form one glyph, the source's own.
      expect(derived.shape("fi").glyphs.map((glyph) => glyph.glyphId)).toEqual(
        source.shape("fi").glyphs.map((glyph) => glyph.glyphId)
      );
      expect(derived.shape("fi").glyphs).toHaveLength(1);
    } finally {
      derived.close();
      source.close();
    }
    expect(app.errors).toEqual([]);
  });

  it("undoes the extension, and the face no longer has the characters", async () => {
    const status = page.locator(".ty-masthead-status");
    await status.getByRole("button", { name: "Undo" }).click();
    await page.getByText(NO_REVISIONS).waitFor();

    await app.goto("/generate/script-extension");
    await section(page, "Result").waitFor();
    expect(await charactersInFace(page)).toBe("0");
    expect(new Set(await standings(page))).toEqual(new Set(["generated"]));
    expect(
      await page.locator('.ty-generate-frame[data-status="proposed"]').count()
    ).toBe(18);
    // The report on screen is of a font the face no longer matches, and says so.
    expect(await section(page, "Verification").innerText()).toContain(
      "The face has changed since this font was built."
    );
    await shoot(
      "7-undone",
      { height: 1800, width: 1440 },
      section(page, "Add to the face")
    );

    // Redo puts the whole of it back, and undo takes the whole of it out.
    await status.getByRole("button", { name: "Redo" }).click();
    await page.getByText(ONE_REVISION).waitFor();
    expect(await charactersInFace(page)).toBe("15");
    await status.getByRole("button", { name: "Undo" }).click();
    await page.getByText(NO_REVISIONS).waitFor();
    expect(await charactersInFace(page)).toBe("0");
    expect(app.errors).toEqual([]);
  });
});
