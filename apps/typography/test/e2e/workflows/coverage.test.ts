/**
 * Select a script, generate missing coverage, validate, package: a pinned Sofia Sans gains Latin letters built by rule.
 *
 * One of the workflows of the eighth milestone, proved in real Chrome: driven
 * through the interface from an empty project, moving from place to place by
 * the links the places offer. Nothing here calls a model. Generated glyphs
 * come from recorded runs, which are saved model output replayed, or from
 * the procedural strategy, which builds by rule.
 */
import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { PORTS } from "../support/ports";
import { BUILD_TIMEOUT, section } from "../support/screen";
import {
  codeOf,
  fixtureFont,
  LINKS_A_WORKFLOW_MEETS,
  SOFIA,
  startWorkflows,
  WORKFLOW_TIMEOUT,
  withFaces,
} from "../support/workflow";

const LATIN_PARTLY = /^Latin, \d+ of 1492/;
const LATIN_SCRIPT = /^Latin\b/;
/** The Studio's address for one glyph of the pinned instance. */
const STUDIO_GLYPH = /^#\/studio\/[^/]+@wght=400\/[^/]+$/;

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
  } = startWorkflows(PORTS.workflowCoverage);

  it(
    "select a script, generate missing coverage, validate, package: a pinned Sofia Sans gains Latin letters built by rule and leaves as a Latin subset",
    async () => {
      const { app, page, places } = on();
      const family = "Sofia Latin";
      const fileName = "SofiaLatin-Regular-subset.ttf";
      /** One run's worth of the missing Latin a rule can build, in code point order. */
      const made = [..."ĈĉĔĕĜĝĤĥĨĩĬĭĴĵŎŏŜŝŨũŬŭǍǎ"];
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
      // The procedural strategy is asked for what a rule can build, and the
      // request counts the rest instead of filling every run with them.
      expect(await section(page, "Generate").innerText()).toContain(
        "These are the first 24 of 210"
      );
      expect(await section(page, "Generate").innerText()).toContain(
        "No rule can build 1046 missing characters from glyphs the face has"
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
      // Every target of the run was one a rule can build.
      expect(await board.innerText()).not.toContain("No candidate was made");
      await expect
        .poll(statusLine)
        .toContain("1 font, 0 revisions, 24 candidates waiting");
      await shoot("3-04-candidates", board, 2600);

      // Accept the ones that pass. Each is a revision.
      await board
        .getByRole("button", {
          name: `Accept everything that passed (${made.length})`,
        })
        .click();
      await expect
        .poll(statusLine)
        .toContain("1 font, 24 revisions, font engine");
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
      // Every link met on the way names a place that exists.
      await collectLinks();
      expect(linksMet()).toBeGreaterThan(LINKS_A_WORKFLOW_MEETS);
      expect(deadLinks()).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );
});
