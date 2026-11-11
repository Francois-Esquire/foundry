/**
 * Import, analyse, extend, validate, export: Lato gains the Devanagari subset and leaves as a renamed font.
 *
 * One of the workflows of the eighth milestone, proved in real Chrome: driven
 * through the interface from an empty project, moving from place to place by
 * the links the places offer. Nothing here calls a model. Generated glyphs
 * come from recorded runs, which are saved model output replayed, or from
 * the procedural strategy, which builds by rule.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import { PORTS } from "../support/ports";
import { BUILD_TIMEOUT, section } from "../support/screen";
import {
  fixtureFont,
  LATO,
  LINKS_A_WORKFLOW_MEETS,
  startWorkflows,
  WORKFLOW_TIMEOUT,
  withFaces,
} from "../support/workflow";

/** A claim the screens must never make. "It is not support for Devanagari" is the opposite claim. */
const SUPPORTS =
  /supports (Devanagari|Hindi)|(Devanagari|Hindi) (is |are )?supported/i;
const SENTENCE_END = /[.!?](?=\s|$)/g;
/** Rows of the composition list, each a link to the script's characters in Coverage. */
const DEVANAGARI_MISSING = /^Devanagari, 0 of \d+/;
const SUBSET_SCOPE =
  "This is a defined subset: 15 characters, 3 forms with no character of their own, and 9 test words. It is not support for Devanagari.";
const RECORDED = "Recorded run, replayed. Not live model output";
const NAMASTE = "नमस्ते";

describe("four workflows from an empty project to a downloaded font, in Chrome", () => {
  const {
    buildPlan,
    collectLinks,
    deadLinks,
    download,
    hash,
    linksMet,
    loadSample,
    on,
    shoot,
    shootNarrow,
    startEmpty,
    statusLine,
    validate,
  } = startWorkflows(PORTS.workflowExtend);

  it(
    "import, analyse, extend, validate, export: Lato gains the Devanagari subset and leaves as a renamed font",
    async () => {
      const { app, page } = on();
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
      // Every link met on the way names a place that exists.
      await collectLinks();
      expect(linksMet()).toBeGreaterThan(LINKS_A_WORKFLOW_MEETS);
      expect(deadLinks()).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );
});
