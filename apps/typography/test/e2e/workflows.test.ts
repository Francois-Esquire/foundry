/**
 * The eighth milestone, proved in real Chrome: four workflows, each driven
 * through the interface from an empty project to a downloaded font, moving
 * from place to place by the links the places offer. Every downloaded file
 * is reopened here with HarfBuzz and checked for what its workflow promises,
 * and goes through the independent validator when uv is installed.
 *
 * Nothing here calls a model. Generated glyphs come from recorded runs, which
 * are saved model output replayed, or from the procedural strategy, which
 * builds by rule.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHash } from "~/app/hash-location";
import { resolveRoute } from "~/app/places";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import { measureInk } from "~/generation/style/measure";
import {
  VALIDATOR_PROGRAM,
  validatorArguments,
} from "~/proof/validator-command";
import type { OpenFace } from "~/typeface/reading";
import { type AppSession, FIXTURE_FONTS, startApp } from "./support/app";

const PORT = 5336;
const APP_ROOT = path.join(import.meta.dirname, "../..");
const WIDE = { height: 900, width: 1440 };
const NARROW = { height: 2600, width: 390 };
const SETTLE_MS = 250;
/** The engine starts in a second or two; a static build takes a few more. */
const BUILD_TIMEOUT = 150_000;
/** Three masters of Sofia Sans take about eleven seconds in Chrome. */
const VARIABLE_BUILD_TIMEOUT = 240_000;
/** One workflow: several builds, a download, and the validator's first run. */
const WORKFLOW_TIMEOUT = 600_000;

const BUILD = /^Build \d+ fonts?$/;
/** A claim the screens must never make. "It is not support for Devanagari" is the opposite claim. */
const SUPPORTS =
  /supports (Devanagari|Hindi)|(Devanagari|Hindi) (is |are )?supported/i;
const SENTENCE_END = /[.!?](?=\s|$)/g;
/** Rows of the composition list, each a link to the script's characters in Coverage. */
const DEVANAGARI_MISSING = /^Devanagari, 0 of \d+/;
const LATIN_PARTLY = /^Latin, \d+ of 1492/;
const LATIN_SCRIPT = /^Latin\b/;
/** The Studio's address for one glyph of the pinned instance. */
const STUDIO_GLYPH = /^#\/studio\/[^/]+@wght=400\/[^/]+$/;

const LATO = "Lato-Regular.ttf";
const SOFIA = "SofiaSans-wght.ttf";

const SUBSET_SCOPE =
  "This is a defined subset: 15 characters, 3 forms with no character of their own, and 9 test words. It is not support for Devanagari.";
const RECORDED = "Recorded run, replayed. Not live model output";
const NAMASTE = "नमस्ते";

const uvIsInstalled = spawnSync(VALIDATOR_PROGRAM, ["--version"]).status === 0;

interface IndependentReport {
  readonly accepted: boolean;
  readonly characters?: { readonly missing: readonly string[] };
  readonly fontTools: { readonly familyName?: string };
}

const section = (page: Page, name: string) =>
  page.getByRole("region", { exact: true, name });

const codeOf = (letter: string) => letter.codePointAt(0) ?? 0;

const fixtureFont = async (file: string) =>
  harfBuzzReader.open(
    new Uint8Array(await readFile(path.join(FIXTURE_FONTS, file)))
  );

/** Opens fonts for one check and closes them whatever the check finds. */
const withFaces = async (
  faces: readonly OpenFace[],
  check: () => void | Promise<void>
) => {
  try {
    await check();
  } finally {
    for (const face of faces) {
      face.close();
    }
  }
};

describe("four workflows from an empty project to a downloaded font, in Chrome", () => {
  let app: AppSession;
  let page: Page;
  let places: Locator;
  let status: Locator;
  let downloads: string;
  /** Every in-app link seen on the way, to check that none leads nowhere. */
  const links = new Set<string>();

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

  const collectLinks = async () => {
    const found = await page
      .locator('a[href^="#"]')
      .evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.getAttribute("href") ?? "")
      );
    for (const href of found) {
      links.add(href);
    }
  };

  /**
   * A picture of one step at 1440 wide, from the top of the screen or of one
   * part of it, tall enough to show the step. Then back to the working size.
   */
  const shoot = async (name: string, from?: Locator, height = 1400) => {
    await collectLinks();
    await resize({ height, width: WIDE.width });
    await scrollTo(from);
    await app.screenshot(`workflow-${name}`);
    await resize(WIDE);
  };

  /** The end of a workflow at 390 wide, where nothing may be wider than the phone. */
  const shootNarrow = async (name: string, from?: Locator) => {
    await resize(NARROW);
    await scrollTo(from);
    await app.screenshot(`workflow-${name}-390`);
    expect(
      await page
        .locator("main")
        .evaluate((main) => main.scrollWidth - main.clientWidth)
    ).toBeLessThanOrEqual(1);
    await resize(WIDE);
  };

  const scrollTo = async (from?: Locator) => {
    if (from) {
      await from.evaluate((element) =>
        element.scrollIntoView({ block: "start" })
      );
    } else {
      await page.locator("main").evaluate((main) => main.scrollTo({ top: 0 }));
    }
    await page.waitForTimeout(SETTLE_MS);
  };

  /** Every workflow starts from an empty project on the first place. */
  const startEmpty = async () => {
    await resize(WIDE);
    await app.goto("/");
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(statusLine).toContain("no fonts yet");
  };

  const hash = () => decodeURIComponent(new URL(page.url()).hash);

  /** The masthead's line. The stylesheet prints it in capitals, so it is read without case. */
  const statusLine = async () => (await status.innerText()).toLowerCase();

  /** Loads one of the sample fonts the start offers. */
  const loadSample = async (file: string) => {
    await page.getByRole("button", { name: `Load ${file}` }).click();
    await page
      .getByRole("table", { name: "Imported source fonts" })
      .getByRole("cell", { exact: true, name: file })
      .waitFor();
  };

  const download = async (button: Locator) => {
    const [saved] = await Promise.all([
      page.waitForEvent("download"),
      button.click(),
    ]);
    const file = path.join(downloads, saved.suggestedFilename());
    await saved.saveAs(file);
    return { bytes: new Uint8Array(await readFile(file)), file };
  };

  /** Builds the plan on screen and waits for one of its fonts. */
  const buildPlan = async (fileName: string) => {
    const planSection = section(page, "Plan");
    await expect.poll(() => planSection.innerText()).toContain(fileName);
    await planSection.getByRole("button", { name: BUILD }).click();
    const built = page
      .getByTestId("built-font")
      .filter({ has: page.getByRole("heading", { name: fileName }) });
    await built.waitFor({ timeout: BUILD_TIMEOUT });
    return built;
  };

  /**
   * The independent validator on a downloaded file: native fontTools, the
   * OpenType Sanitizer and native HarfBuzz. Skipped, and said so, without uv.
   */
  const validate = (
    file: string,
    expected: { characters: readonly number[]; shape: string }
  ): IndependentReport | undefined => {
    if (!uvIsInstalled) {
      console.warn(
        `Skipped the independent validator on ${path.basename(file)}: uv is not on PATH.`
      );
      return;
    }
    const result = spawnSync(
      VALIDATOR_PROGRAM,
      validatorArguments({ ...expected, fontPath: file }),
      { cwd: APP_ROOT, encoding: "utf8" }
    );
    if (!result.stdout) {
      throw new Error(`The validator printed no report: ${result.stderr}`);
    }
    const report = JSON.parse(result.stdout) as IndependentReport;
    expect(report.characters?.missing).toEqual([]);
    expect(report.accepted).toBe(true);
    expect(result.status).toBe(0);
    return report;
  };

  beforeAll(async () => {
    downloads = await mkdtemp(path.join(tmpdir(), "typography-workflows-"));
    app = await startApp({ port: PORT, ...WIDE });
    ({ page } = app);
    places = page.getByRole("navigation", { name: "Places" });
    status = page.locator(".ty-masthead-status");
  });

  afterAll(async () => {
    await app.close();
    await rm(downloads, { force: true, recursive: true });
  });

  it(
    "import, analyse, extend, validate, export: Lato gains the Devanagari subset and leaves as a renamed font",
    async () => {
      const family = "Atlas Sans";
      const fileName = "AtlasSans-Regular.ttf";
      await startEmpty();

      // The start says what the app does in two sentences and offers both ways in.
      const start = section(page, "Start");
      const said = await start.locator(".ty-lede").innerText();
      expect(said.match(SENTENCE_END)).toHaveLength(2);
      expect(
        await start.getByRole("link", { name: "Open Reconstruct" }).count()
      ).toBe(1);
      await page.getByLabel("Add font files").waitFor({ state: "attached" });
      await page
        .getByRole("table", { name: "Sample fonts and their licences" })
        .waitFor();
      await shoot("1-01-start");
      await shootNarrow("1-01-start");

      await loadSample(LATO);
      expect(await start.count()).toBe(0);
      await expect
        .poll(statusLine)
        .toContain("1 font, 0 revisions, font engine not started");
      await shoot("1-02-imported");

      // Coverage: Devanagari is missing, and the extension is offered as the subset it is.
      await page.getByRole("link", { name: "Open coverage" }).click();
      await page
        .getByRole("link", { name: DEVANAGARI_MISSING })
        .first()
        .click();
      await expect.poll(hash).toBe("#/coverage/Deva");
      const coverage = page.locator(".ty-coverage-main");
      await expect
        .poll(() => coverage.innerText())
        .toContain("0 of 164 characters in Lato Regular");
      const offer = coverage.locator("output").filter({ hasText: "on offer" });
      expect(await offer.innerText()).toContain(
        "a defined Devanagari subset, added whole"
      );
      expect(await offer.innerText()).toContain(SUBSET_SCOPE);
      expect(await coverage.innerText()).toContain(
        "Lato Regular lacks 164 of the characters of Devanagari."
      );
      expect(await page.locator("main").innerText()).not.toMatch(SUPPORTS);
      await shoot("1-03-coverage-devanagari-missing");
      await shootNarrow("1-03-coverage-devanagari-missing", coverage);

      // The link carries the face: nothing is chosen again in Generate.
      const faceId = await page.evaluate(() => {
        const link = document.querySelector<HTMLAnchorElement>(
          '.ty-coverage-main output a[href^="#/generate/script-extension/"]'
        );
        return decodeURIComponent(link?.getAttribute("href") ?? "")
          .split("/")
          .at(-1);
      });
      await offer
        .getByRole("link", { name: "Open the script extension" })
        .click();
      await section(page, "Script extension").waitFor();
      expect(hash()).toBe(`#/generate/script-extension/${faceId}`);
      expect(await page.locator("[data-extension-scope]").innerText()).toBe(
        SUBSET_SCOPE
      );
      await shoot("1-04-extension-scope", undefined, 2400);

      // The recorded run is replayed, and named as recorded.
      const run = section(page, "Run");
      await run
        .getByRole("button", { name: "Replay the recorded run" })
        .click();
      const result = page.locator("[data-extension-result]");
      await result.waitFor();
      expect(await result.getAttribute("data-glyphs")).toBe("18");
      expect(await result.getAttribute("data-missing")).toBe("0");
      expect(await section(page, "Result").innerText()).toContain(RECORDED);
      // The extension goes in whole or not at all, so nothing waits as a candidate.
      expect(await statusLine()).toContain(
        "1 font, 0 revisions, font engine not started"
      );
      await shoot("1-05-extension-replayed", section(page, "Result"), 2600);

      // Added whole, as one revision.
      const add = section(page, "Add to the face");
      await add
        .getByRole("button", {
          name: "Add the whole extension to Lato Regular",
        })
        .click();
      await expect
        .poll(statusLine)
        .toContain("1 font, 1 revision, font engine");
      expect(await statusLine()).not.toContain("waiting");
      await shoot("1-06-extension-added", add);

      // Verified in a font the engine builds.
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
      await expect.poll(statusLine).toContain("font engine ready");
      await shoot("1-07-extension-verified", verification, 2600);

      // Proof: the plan's test words arrive as the text, set in the built font.
      const words = plan.words.map((word) => word.text).join(" ");
      await section(page, "Next")
        .getByRole("link", { name: "Prove Lato Regular" })
        .click();
      await expect.poll(hash).toBe(`#/proof/face/${faceId}/${words}`);
      await page.getByRole("button", { name: "Build and prove" }).click();
      const inText = section(page, "In text");
      await inText.waitFor({ timeout: BUILD_TIMEOUT });
      expect(await inText.getByLabel("Proof text").inputValue()).toBe(words);
      const specimen = (caption: string) =>
        inText.locator("figure").filter({ hasText: caption });
      const derived = specimen("Derived font").locator(".ty-proof-text");
      await derived.waitFor();
      // The built font draws every test word. The source font draws none of them.
      expect(await derived.locator(".ty-tofu").count()).toBe(0);
      expect(await derived.innerText()).toContain(NAMASTE);
      expect(
        await specimen("Source font").locator(".ty-tofu").count()
      ).toBeGreaterThan(20);
      expect(await page.locator("main").innerText()).not.toMatch(SUPPORTS);
      await shoot("1-08-proof-test-words", inText);

      // Export: the face is already chosen. Only the new name is typed.
      await page.getByRole("link", { name: "Plan an export" }).click();
      const faces = section(page, "Faces");
      await faces.waitFor();
      expect(hash()).toBe(`#/export/face/${faceId}`);
      expect(
        await faces.getByRole("checkbox", { name: "Lato Regular" }).isChecked()
      ).toBe(true);
      await page.getByLabel("Family name").fill(family);
      const built = await buildPlan(fileName);
      expect(await built.innerText()).toContain("6 of 6 checks passed");
      await shoot("1-09-export-built", built, 1800);
      await shootNarrow("1-09-export-built", built);

      const saved = await download(
        built.getByRole("button", { name: `Download ${fileName}` })
      );
      expect(path.basename(saved.file)).toBe(fileName);

      const source = await fixtureFont(LATO);
      const exported = harfBuzzReader.open(saved.bytes);
      await withFaces([source, exported], () => {
        // The engine appends added glyphs in plan order after the source font's own.
        const firstAdded = source.description.glyphCount;
        const shaped = exported
          .shape(NAMASTE, { script: plan.iso15924 })
          .glyphs.map(
            (glyph) =>
              plan.glyphs[glyph.glyphId - firstAdded]?.name ??
              `source:${glyph.glyphId}`
          );
        expect(exported.description.familyName).toBe(family);
        expect(shaped).toEqual(
          plan.words.find((word) => word.text === NAMASTE)?.glyphs
        );
        expect(shaped).toEqual([
          "na-deva",
          "ma-deva",
          "sa-deva.half",
          "ta-deva",
          "eMatra-deva",
        ]);
        // Latin is as it was: f and i still form one glyph, the source's own.
        const ligature = exported.shape("fi").glyphs;
        expect(ligature).toHaveLength(1);
        expect(ligature.map((glyph) => glyph.glyphId)).toEqual(
          source.shape("fi").glyphs.map((glyph) => glyph.glyphId)
        );
      });
      const report = validate(saved.file, {
        characters: plan.glyphs.flatMap((glyph) => glyph.characters),
        shape: NAMASTE,
      });
      expect(report?.fontTools.familyName ?? family).toBe(family);
      expect(app.errors).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );

  it(
    "capture, reconstruct, complete, refine, export: the storefront banner becomes a new face, is completed from the recorded run, edited and exported",
    async () => {
      const family = "Storefront Needed Things";
      const fileName = "StorefrontNeededThings-Regular.ttf";
      const reads = "NEEDEDTHINGSFORSALE";
      const observed = [...new Set(reads)];
      const inferred = [..."BCJKMPQUVWXYZ&?"];
      const newAdvance = 640;
      /** The lettering of the banner, in pixels of the 1280 by 960 photograph. */
      const banner = { height: 196, width: 400, x: 432, y: 162 };
      const part = (heading: string) =>
        page.locator("section.ty-section", {
          has: page.getByRole("heading", {
            exact: true,
            level: 2,
            name: heading,
          }),
        });
      const numberOf = async (locator: Locator, attribute: string) =>
        Number(await locator.getAttribute(attribute));
      await startEmpty();

      // The second way in: bring an image.
      await section(page, "Start")
        .getByRole("link", { name: "Open Reconstruct" })
        .click();
      await page
        .getByRole("button", { name: "Open storefront banner" })
        .click();
      const picture = page.locator("svg.ty-reconstruct-marking");
      await picture.waitFor();
      await picture.scrollIntoViewIfNeeded();
      const box = await picture.boundingBox();
      if (!box) {
        throw new Error("The photograph is not on screen.");
      }
      const at = (x: number, y: number) =>
        [
          box.x + (x / 1280) * box.width,
          box.y + (y / 960) * box.height,
        ] as const;
      await page.mouse.move(...at(banner.x, banner.y));
      await page.mouse.down();
      await page.mouse.move(
        ...at(banner.x + banner.width / 2, banner.y + banner.height / 2),
        { steps: 4 }
      );
      await page.mouse.move(
        ...at(banner.x + banner.width, banner.y + banner.height),
        { steps: 4 }
      );
      await page.mouse.up();
      const letters = part("Letters");
      const found = letters.locator("p[data-found]");
      await found.waitFor();
      expect(await numberOf(found, "data-found")).toBe(reads.length);

      // With no font in the project nothing can be read, and the screen says so.
      expect(await numberOf(found, "data-labelled")).toBe(0);
      expect(await letters.innerText()).toContain(
        "No face in the library draws these characters"
      );
      expect(await statusLine()).toContain("no fonts yet");
      await shoot("2-01-letters-found-unread", part("Region"), 2400);

      // Its way out leads to Import. Two sample fonts, and back: the letters are read.
      await letters.getByRole("link", { name: "Open Import" }).click();
      await loadSample(LATO);
      await loadSample(SOFIA);
      await places.getByRole("link", { name: "Reconstruct" }).click();
      await letters
        .getByRole("radio", { name: "Capitals" })
        .check({ force: true });
      const cells = letters.locator("li.ty-reconstruct-letter");
      await expect.poll(() => cells.count()).toBe(reads.length);
      await expect
        .poll(() => numberOf(found, "data-labelled"))
        .toBe(reads.length);
      const readAs = async () =>
        (
          await Promise.all(
            (
              await cells.all()
            ).map((cell) => cell.getByRole("textbox").inputValue())
          )
        ).join("");
      const machine = await readAs();
      const right = [...machine].filter(
        (letter, index) => letter === reads[index]
      ).length;
      console.info(
        `Storefront banner read as ${machine}: ${right} of ${reads.length} right before any correction.`
      );
      expect(right).toBeGreaterThan(reads.length / 2);
      // A person corrects what the recogniser got wrong by typing over it.
      for (const [index, letter] of [...reads].entries()) {
        if (machine[index] !== letter) {
          await cells.nth(index).getByRole("textbox").fill(letter);
        }
      }
      await expect.poll(readAs).toBe(reads);
      await shoot("2-02-letters-read", letters, 2000);

      // Recovered into a new face, made for this reconstruction.
      const outlines = part("Outlines");
      await expect
        .poll(() => numberOf(outlines.locator("p[data-traced]"), "data-traced"))
        .toBe(reads.length);
      const candidates = part("Candidates");
      expect(
        await candidates
          .getByRole("textbox", { name: "Family name of the new face" })
          .inputValue()
      ).toBe(family);
      await candidates
        .getByRole("button", {
          name: `Propose ${observed.length} letters as candidates`,
        })
        .click();
      const board = candidates.getByRole("list", { name: "Observed letters" });
      await board.waitFor({ timeout: BUILD_TIMEOUT });
      await expect
        .poll(statusLine)
        .toContain(
          "3 fonts, 0 revisions, 13 candidates waiting, font engine ready"
        );
      expect(await board.locator('li[data-basis="observed"]').count()).toBe(
        observed.length
      );
      await candidates
        .getByRole("button", {
          name: `Accept all ${observed.length} proposed letters`,
        })
        .click();
      const standing = candidates.locator("p[data-revisions]");
      await expect
        .poll(() => numberOf(standing, "data-revisions"))
        .toBe(observed.length);
      const faceId = (await standing.getAttribute("data-face")) ?? "";
      await shoot("2-03-observed-accepted", candidates, 2400);

      // The rest of the alphabet from the recorded run, shown as inferred until accepted.
      const completion = part("Completion");
      await completion.getByRole("radio", { name: "Recorded run" }).check();
      await completion
        .getByRole("button", { name: "Infer the missing characters" })
        .click();
      const drawn = completion.locator("p[data-inferred]");
      await drawn.waitFor();
      expect(await drawn.getAttribute("data-recorded")).toBe("true");
      expect(await numberOf(drawn, "data-inferred")).toBe(inferred.length);
      expect(await drawn.innerText()).toContain("Not live model output.");
      const inferredBoard = completion.getByRole("list", {
        name: "Inferred letters",
      });
      expect(
        await inferredBoard.locator('li[data-basis="inferred"]').count()
      ).toBe(inferred.length);
      expect(
        await inferredBoard
          .locator('.ty-reconstruct-frame[data-unconfirmed="true"]')
          .count()
      ).toBe(inferred.length);
      await completion
        .getByRole("button", {
          name: "Fit their width to the observed letters",
        })
        .click();
      await completion
        .getByRole("button", {
          name: `Propose ${inferred.length} inferred letters as candidates`,
        })
        .click();
      await expect
        .poll(statusLine)
        .toContain("13 revisions, 15 candidates waiting");
      await shoot("2-04-completion-inferred", completion, 3200);
      await completion
        .getByRole("button", {
          name: `Accept all ${inferred.length} proposed inferred letters`,
        })
        .click();
      await expect
        .poll(() => numberOf(standing, "data-revisions"))
        .toBe(observed.length + inferred.length);
      // Accepted, an inferred letter is in the face, and still says it was inferred.
      expect(
        await inferredBoard.locator('li[data-basis="inferred"]').count()
      ).toBe(inferred.length);

      // One letter opens in the Studio and is edited there.
      await board.getByRole("link", { name: "Open N in the Studio" }).click();
      const drawing = page.getByRole("application");
      await drawing.waitFor();
      expect(hash()).toContain(`#/studio/${faceId}/`);
      const inspector = page.getByRole("complementary", {
        name: "Measures and revisions",
      });
      const revisions = inspector.locator("ol.ty-studio-revisions");
      const before = await numberOf(revisions, "data-revisions");
      expect(before).toBe(observed.length + inferred.length);
      const outlineBefore = await page
        .locator("path.ty-studio-edit")
        .getAttribute("d");
      await drawing.focus();
      await page.keyboard.press("PageDown");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowRight");
      expect(
        await page.locator("path.ty-studio-edit").getAttribute("d")
      ).not.toBe(outlineBefore);
      const advance = inspector.getByRole("textbox", {
        name: "Advance, in font units",
      });
      await advance.fill(String(newAdvance));
      await advance.press("Enter");
      await expect
        .poll(() => numberOf(revisions, "data-revisions"))
        .toBe(before + 2);
      await shoot("2-05-studio-edited");

      // The Studio's way on carries the face to Export.
      const next = section(page, "Next");
      await shootNarrow("2-05-studio-next", next);
      await next.getByRole("link", { name: "Plan an export" }).click();
      const faces = section(page, "Faces");
      await faces.waitFor();
      expect(hash()).toBe(`#/export/face/${faceId}`);
      expect(
        await faces
          .getByRole("checkbox", { name: `${family} Regular` })
          .isChecked()
      ).toBe(true);
      const built = await buildPlan(fileName);
      // The source is the empty font the engine made, so there is no source
      // shaping to compare with: those two checks say they did not run.
      expect(await built.innerText()).toContain(
        "4 of 6 checks passed, 2 did not run"
      );
      expect(await built.innerText()).toContain(
        "All 29 requested characters are in the font."
      );
      await shoot("2-06-export-built", built, 1800);
      await shootNarrow("2-06-export-built", built);

      const saved = await download(
        built.getByRole("button", { name: `Download ${fileName}` })
      );
      const exported = harfBuzzReader.open(saved.bytes);
      await withFaces([exported], () => {
        expect(exported.description.familyName).toBe(family);
        // Observed and inferred letters are in the same font: the whole alphabet, and two more.
        for (const letter of [...observed, ...inferred]) {
          const glyph = exported.glyphForCharacter(codeOf(letter));
          expect(glyph).toBeDefined();
          expect(
            exported.glyph(glyph ?? 0).outline.contours.length
          ).toBeGreaterThan(0);
        }
        expect(
          [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].every(
            (letter) => exported.glyphForCharacter(codeOf(letter)) !== undefined
          )
        ).toBe(true);
        // The hand edit made in the Studio is in the file.
        const edited = exported.glyphForCharacter(codeOf("N")) ?? 0;
        expect(exported.glyph(edited).advance).toBe(newAdvance);
        expect(exported.shape("NEEDED THINGS").glyphs.length).toBeGreaterThan(
          10
        );
      });
      validate(saved.file, {
        characters: [...observed, ...inferred].map(codeOf),
        shape: "NEEDEDTHINGS",
      });
      expect(app.errors).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );

  it(
    "select a script, generate missing coverage, validate, package: a pinned Sofia Sans gains Latin letters built by rule and leaves as a Latin subset",
    async () => {
      const family = "Sofia Latin";
      const fileName = "SofiaLatin-Regular-subset.ttf";
      /** What a rule can build of the first run's worth of missing Latin. */
      const made = [..."ĈĉĔĕĜĝĤĥĨĩĬĭĴĵŎŏŜŝŨũŬ"];
      await startEmpty();
      await loadSample(SOFIA);

      // The Library leads a variable face to the Studio, where an instance is pinned.
      await page.getByRole("link", { name: "Open the library" }).click();
      await page
        .getByRole("link", { name: "Pin an instance in the Studio" })
        .click();
      await page.getByRole("button", { name: "Pin Regular" }).click();
      await page.getByRole("application").waitFor();
      const faceId = hash().split("/")[2] ?? "";
      expect(faceId).toContain("@wght=400");
      await shoot("3-01-studio-pinned");

      // Coverage looks at the pinned instance: Latin is partly there.
      await places.getByRole("link", { name: "Coverage" }).click();
      await page.getByRole("link", { name: LATIN_PARTLY }).first().click();
      await expect.poll(hash).toBe("#/coverage/Latn");
      const coverage = page.locator(".ty-coverage-main");
      await expect
        .poll(() => coverage.innerText())
        .toContain("236 of 1492 characters in Sofia Sans Regular");
      expect(await coverage.innerText()).toContain(
        "Sofia Sans Regular lacks 1256 of the characters of Latin."
      );
      // No script extension is on offer for Latin, so none is offered.
      expect(await coverage.locator("output").count()).toBe(0);
      // A character the face has leads from its inspector into the Studio.
      const find = page.getByRole("searchbox", { name: "Find a character" });
      await find.fill("U+0061");
      await page.locator('button[aria-label^="U+0061"]').first().click();
      const inStudio = page
        .getByRole("complementary", { name: "Character" })
        .getByRole("link", { name: "Open in the Studio" });
      expect(
        decodeURIComponent((await inStudio.getAttribute("href")) ?? "")
      ).toMatch(STUDIO_GLYPH);
      await find.fill("");
      await shoot("3-02-coverage-latin-partly");

      // Generate opens on that face with that writing system already chosen.
      await coverage
        .getByRole("link", { name: "Generate what is missing" })
        .click();
      await section(page, "Generate").waitFor();
      expect(hash()).toBe(`#/generate/${faceId}/Latn`);
      expect(
        await page.getByRole("radio", { name: "Writing system" }).isChecked()
      ).toBe(true);
      const scope = page.getByRole("combobox", {
        name: "Missing in the writing system",
      });
      expect(await scope.locator("option:checked").innerText()).toBe("Latin");
      const targets = page.getByRole("table", {
        name: "Targets of this request and what each depends on",
      });
      await expect.poll(() => targets.locator("tbody tr").count()).toBe(24);
      expect(await section(page, "Generate").innerText()).toContain(
        "These are the first 24 of 1256"
      );
      expect(
        await page
          .getByRole("radio", { exact: true, name: "Procedural" })
          .isChecked()
      ).toBe(true);
      await shoot("3-03-generate-request", undefined, 2200);

      // By rule, on this machine: what a rule can build becomes a candidate.
      await page.getByRole("button", { name: "Generate 24 glyphs" }).click();
      const candidates = page.locator("li.ty-generate-candidate");
      await expect.poll(() => candidates.count()).toBe(made.length);
      const board = section(page, "Candidates");
      expect(
        await board.locator("[data-run-source]").getAttribute("data-run-source")
      ).toBe("live");
      expect(await candidates.first().innerText()).toContain(
        "Built by rule on this machine"
      );
      expect(await board.innerText()).toContain(
        "No candidate was made for 3 of 24 targets."
      );
      await expect
        .poll(statusLine)
        .toContain("1 font, 0 revisions, 21 candidates waiting");
      await shoot("3-04-candidates", board, 2600);

      // Accept the ones that pass. Each is a revision.
      await board
        .getByRole("button", {
          name: `Accept everything that passed (${made.length})`,
        })
        .click();
      await expect
        .poll(statusLine)
        .toContain("1 font, 21 revisions, font engine");
      expect(
        await page
          .locator('li.ty-generate-candidate[data-status="accepted"]')
          .count()
      ).toBe(made.length);
      const next = section(page, "Next");
      await shoot("3-05-accepted", next);
      await shootNarrow("3-05-accepted", next);

      // Prove them: the accepted characters arrive as the text.
      await next
        .getByRole("link", { name: "Prove Sofia Sans Regular" })
        .click();
      await expect.poll(hash).toBe(`#/proof/face/${faceId}/${made.join(" ")}`);
      await page.getByRole("button", { name: "Build and prove" }).click();
      const inText = section(page, "In text");
      await inText.waitFor({ timeout: BUILD_TIMEOUT });
      const specimen = (caption: string) =>
        inText.locator("figure").filter({ hasText: caption });
      const derived = specimen("Derived font").locator(".ty-proof-text");
      await derived.waitFor();
      expect(await derived.locator(".ty-tofu").count()).toBe(0);
      expect(await specimen("Source font").locator(".ty-tofu").count()).toBe(
        made.length
      );
      await shoot("3-06-proof-new-letters", inText);

      // Back to the board, whose way on to Export carries the face and the script.
      await page.goBack();
      await next
        .getByRole("link", { name: "Plan an export of the Latin subset" })
        .click();
      const faces = section(page, "Faces");
      await faces.waitFor();
      expect(hash()).toBe(`#/export/face/${faceId}/Latn`);
      const chosen = await faces
        .locator("li")
        .filter({ has: page.getByRole("checkbox", { checked: true }) })
        .allInnerTexts();
      expect(chosen).toHaveLength(1);
      expect(chosen[0]).toContain("Pinned at wght 400.");
      const characters = section(page, "Characters");
      expect(
        await characters.getByRole("radio", { name: "A selection" }).isChecked()
      ).toBe(true);
      expect(
        await characters
          .getByRole("checkbox", { name: LATIN_SCRIPT })
          .first()
          .isChecked()
      ).toBe(true);
      await page.getByLabel("Family name").fill(family);
      const built = await buildPlan(fileName);
      const outcomes = await built
        .locator("tbody tr .ty-outcome")
        .evaluateAll((tags) =>
          tags.map((tag) => tag.textContent?.trim() ?? "")
        );
      expect(outcomes).not.toContain("Fail");
      console.info(`Latin subset, validation results: ${outcomes.join(" ")}`);
      await shoot("3-07-export-built", built, 1800);
      await shootNarrow("3-07-export-built", built);

      const saved = await download(
        built.getByRole("button", { name: `Download ${fileName}` })
      );
      const source = await fixtureFont(SOFIA);
      const exported = harfBuzzReader.open(saved.bytes);
      await withFaces([source, exported], () => {
        expect(exported.description.familyName).toBe(family);
        expect(exported.description.axes).toEqual([]);
        for (const letter of made) {
          expect(source.glyphForCharacter(codeOf(letter))).toBeUndefined();
          expect(exported.glyphForCharacter(codeOf(letter))).toBeDefined();
        }
        // A subset for Latin: the source's Latin stays, its Greek and its digits go.
        expect(exported.glyphForCharacter(codeOf("a"))).toBeDefined();
        for (const other of ["Α", "Я", "7"]) {
          expect(source.glyphForCharacter(codeOf(other))).toBeDefined();
          expect(exported.glyphForCharacter(codeOf(other))).toBeUndefined();
        }
        const shaped = exported.shape(made.join("")).glyphs;
        expect(shaped).toHaveLength(made.length);
        expect(shaped.every((glyph) => glyph.glyphId !== 0)).toBe(true);
      });
      const report = validate(saved.file, {
        characters: made.map(codeOf),
        shape: made.join(""),
      });
      expect(report?.fontTools.familyName ?? family).toBe(family);
      expect(app.errors).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );

  it(
    "select a family, generate coordinated variants, export: Sofia Sans gains letters at three weights and leaves as three static fonts and as one variable font",
    async () => {
      const family = "Sofia Extended";
      /** The axis minimum, default and maximum: the three weights the place starts with. */
      const weights = [1, 400, 1000];
      const styles = ["wght1", "Regular", "wght1000"];
      const staticFiles = styles.map((style) => `SofiaExtended-${style}.ttf`);
      const variableFile = "SofiaExtended-VariableRebuilt.ttf";
      const added = ["ĉ", "ĝ", "ũ", "Ĥ"];
      /** A weight between two masters, where nothing was drawn. */
      const between = 700;
      await startEmpty();
      await loadSample(SOFIA);

      // The Library leads a variable face straight to Generate across weights.
      await page.getByRole("link", { name: "Open the library" }).click();
      await section(page, "Face").waitFor();
      await shoot("4-00-library-variable-face", section(page, "Face"), 900);
      await shootNarrow("4-00-library-variable-face", section(page, "Face"));
      await page.getByRole("link", { name: "Generate across weights" }).click();
      await section(page, "Generate across weights").waitFor();
      const variableId = hash().split("/")[2] ?? "";
      expect(variableId).not.toContain("@");
      await expect
        .poll(() => page.getByTestId("family-weights").innerText())
        .toContain(
          "3 weights, lightest first: wght1 (1), Regular (400), wght1000 (1000)"
        );
      await page
        .getByRole("textbox", { name: "Characters" })
        .fill(added.join(" "));
      await shoot("4-01-across-weights", undefined, 2200);

      // The same characters on each weight, by rule. Each weight becomes a pinned instance.
      await page
        .getByRole("button", {
          name: `Generate ${added.length} glyphs at 3 weights`,
        })
        .click();
      const rows = page.locator("li.ty-family-character");
      await expect.poll(() => rows.count()).toBe(added.length);
      const board = section(page, "Candidates across weights");
      expect(await board.innerText()).toContain(
        "Built by rule on this machine. No model was called."
      );
      await expect
        .poll(statusLine)
        .toContain("1 font, 0 revisions, 12 candidates waiting");
      await board
        .getByRole("button", {
          name: `Accept everything that is compatible (${added.length} characters)`,
        })
        .click();
      await expect
        .poll(statusLine)
        .toContain("1 font, 12 revisions, font engine");
      // Every accepted cell leads to its glyph on its own pinned instance.
      const studioLinks = await board
        .locator('li.ty-family-cell[data-status="accepted"] a')
        .evaluateAll((anchors) =>
          anchors.map((anchor) =>
            decodeURIComponent(anchor.getAttribute("href") ?? "")
          )
        );
      expect(studioLinks).toHaveLength(added.length * weights.length);
      // Each names its character and weight for a reader who cannot see the cell.
      expect(
        await board
          .locator('li.ty-family-cell[data-status="accepted"] a')
          .first()
          .textContent()
      ).toBe("Open in the Studio, ĉ at wght1");
      for (const weight of weights) {
        expect(
          studioLinks.filter((href) =>
            href.startsWith(`#/studio/${variableId}@wght=${weight}/`)
          )
        ).toHaveLength(added.length);
      }
      await shoot("4-02-accepted-at-three-weights", board, 3200);

      // Export opens with the three pinned instances chosen, and not the variable face.
      const next = section(page, "Next");
      await shootNarrow("4-02-next", next);
      await next
        .getByRole("link", { name: "Plan an export of the pinned instances" })
        .click();
      const faces = section(page, "Faces");
      await faces.waitFor();
      expect(hash()).toBe(`#/export/instances/${variableId}`);
      const row = (note: string) =>
        faces.locator("li").filter({ hasText: note }).getByRole("checkbox");
      expect(await row("Variable, 1 axis").isChecked()).toBe(false);
      for (const weight of weights) {
        expect(await row(`Pinned at wght ${weight}.`).isChecked()).toBe(true);
      }
      await page.getByLabel("Family name").fill(family);

      // Three static fonts.
      const planSection = section(page, "Plan");
      for (const file of staticFiles) {
        await expect.poll(() => planSection.innerText()).toContain(file);
      }
      await planSection.getByRole("button", { name: BUILD }).click();
      const built = page.getByTestId("built-font");
      await expect
        .poll(() => built.count(), { timeout: BUILD_TIMEOUT })
        .toBe(staticFiles.length);
      const outcomes = await section(page, "Built fonts")
        .locator("tbody tr .ty-outcome")
        .evaluateAll((tags) =>
          tags.map((tag) => tag.textContent?.trim() ?? "")
        );
      expect(outcomes).not.toContain("Fail");
      await shoot(
        "4-03-three-static-fonts",
        section(page, "Built fonts"),
        3600
      );
      const statics: { bytes: Uint8Array; file: string }[] = [];
      for (const file of staticFiles) {
        statics.push(
          await download(page.getByRole("button", { name: `Download ${file}` }))
        );
      }

      // One variable font, rebuilt from the same three instances as masters.
      const variableFont = section(page, "Variable font");
      await variableFont
        .getByRole("radio", { name: "One variable font" })
        .check({ force: true });
      await expect
        .poll(() => variableFont.getByTestId("variable-file").innerText())
        .toBe(variableFile);
      await variableFont
        .getByRole("button", { name: "Build the variable font" })
        .click();
      const rebuilt = variableFont.getByTestId("built-variable-font");
      await rebuilt.waitFor({ timeout: VARIABLE_BUILD_TIMEOUT });
      expect(await rebuilt.innerText()).toContain(
        "2 of 2 checks that ran passed"
      );
      await shoot("4-04-one-variable-font", rebuilt, 1800);
      await shootNarrow("4-04-one-variable-font", rebuilt);
      const variable = await download(
        rebuilt.getByRole("button", { name: `Download ${variableFile}` })
      );
      expect(path.basename(variable.file)).toBe(variableFile);

      const source = await fixtureFont(SOFIA);
      const masters = statics.map(({ bytes }) => harfBuzzReader.open(bytes));
      const face = harfBuzzReader.open(variable.bytes);
      const inkOf = (font: OpenFace, letter: string, weight?: number) => {
        const glyph = font.glyphForCharacter(codeOf(letter));
        if (glyph === undefined) {
          throw new Error(`The font does not map ${letter}.`);
        }
        const { outline } = font.glyph(
          glyph,
          weight === undefined ? undefined : { wght: weight }
        );
        return (
          measureInk(outline, font.description.metrics.unitsPerEm)?.area ?? 0
        );
      };
      await withFaces([source, face, ...masters], () => {
        for (const [index, master] of masters.entries()) {
          expect(master.description.axes).toEqual([]);
          expect(master.description.familyName).toBe(family);
          expect(master.description.weightClass).toBe(weights[index]);
        }
        expect(face.description.familyName).toBe(family);
        expect(face.description.axes).toEqual([
          { default: 400, max: 1000, min: 1, name: "Weight", tag: "wght" },
        ]);
        for (const letter of added) {
          expect(source.glyphForCharacter(codeOf(letter))).toBeUndefined();
          // The same letter on each static font, heavier at each weight.
          const fixed = masters.map((master) => inkOf(master, letter));
          expect(fixed[0]).toBeGreaterThan(0);
          expect(fixed).toEqual(fixed.toSorted((a, b) => a - b));
          expect(new Set(fixed).size).toBe(fixed.length);
          // In the variable font it gets heavier all along the axis, between masters too.
          const along = [weights[0], weights[1], between, weights[2]].map(
            (weight) => inkOf(face, letter, weight)
          );
          expect(along).toEqual(along.toSorted((a, b) => a - b));
          expect(new Set(along).size).toBe(along.length);
        }
      });
      for (const { file } of [...statics, variable]) {
        const report = validate(file, {
          characters: added.map(codeOf),
          shape: added.join(""),
        });
        expect(report?.fontTools.familyName ?? family).toBe(family);
      }
      expect(app.errors).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );

  it(
    "follows an address in a session already in use, leaves a bare address alone, and says so when an address names nothing",
    async () => {
      await startEmpty();
      await loadSample(LATO);
      await page.getByRole("link", { name: "Open the library" }).click();
      const faceId =
        decodeURIComponent(
          (await page
            .getByRole("link", { name: "Open in the Studio" })
            .getAttribute("href")) ?? ""
        ).split("/")[2] ?? "";
      const face = encodeURIComponent(faceId);
      const main = page.locator("main");

      // Generate follows each address in turn. A bare address changes nothing.
      const chosenScope = () =>
        page
          .getByRole("combobox", { name: "Missing in the writing system" })
          .locator("option:checked")
          .innerText();
      await app.goto(`/generate/${face}/Grek`);
      await expect.poll(chosenScope).toBe("Greek");
      await app.goto(`/generate/${face}/Deva`);
      await expect.poll(chosenScope).toBe("Devanagari");
      await app.goto("/generate");
      await section(page, "Generate").waitFor();
      expect(await chosenScope()).toBe("Devanagari");
      await app.goto("/generate/no-such-face/Klingon");
      await expect
        .poll(() => main.innerText())
        .toContain("The face in this address is not in the project.");
      expect(await chosenScope()).toBe("Devanagari");

      // Export: a subset asked for by one address does not cut down the next,
      // which asks for the face whole.
      const keeps = (name: string) =>
        section(page, "Characters").getByRole("radio", { name }).isChecked();
      await app.goto(`/export/face/${face}/Latn`);
      await section(page, "Characters").waitFor();
      await expect.poll(() => keeps("A selection")).toBe(true);
      await app.goto(`/export/face/${face}`);
      await expect.poll(() => keeps("Everything")).toBe(true);
      // What is chosen by hand stays through a bare address and a wrong one.
      await section(page, "Characters")
        .getByRole("radio", { name: "A selection" })
        .check({ force: true });
      await app.goto("/export");
      await section(page, "Characters").waitFor();
      expect(await keeps("A selection")).toBe(true);
      await app.goto("/export/face/no-such-face");
      await expect
        .poll(() => main.innerText())
        .toContain("The face in this address is not in the project");
      expect(await keeps("A selection")).toBe(true);
      await app.goto("/export/nothing/here");
      await expect
        .poll(() => main.innerText())
        .toContain("This address names nothing to plan an export from");

      // Proof says so too, and its way on to Export is there whatever has been built.
      await app.goto("/proof/nothing");
      await expect
        .poll(() => main.innerText())
        .toContain("This address names no font to prove.");
      await app.goto(`/proof/face/${face}`);
      expect(
        decodeURIComponent(
          (await page
            .getByRole("link", { name: "Plan an export" })
            .getAttribute("href")) ?? ""
        )
      ).toBe(`#/export/face/${faceId}`);
      await app.goto("/nowhere/at/all");
      await expect.poll(() => main.innerText()).toContain("No such place");
      await collectLinks();
      expect(app.errors).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );

  it("leads nowhere dead: every link met on the way names a place that exists", () => {
    expect(links.size).toBeGreaterThan(20);
    const dead = [...links].filter(
      (href) => resolveRoute(parseHash(href)).kind !== "destination"
    );
    expect(dead).toEqual([]);
  });
});
