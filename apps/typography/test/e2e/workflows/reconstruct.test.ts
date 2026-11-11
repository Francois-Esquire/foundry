import type { Locator } from "playwright-core";
import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { PORTS } from "../support/ports";
import { BUILD_TIMEOUT, section } from "../support/screen";
import {
  codeOf,
  LATO,
  NAVIGATION_LINKS,
  SOFIA,
  startWorkflows,
  WORKFLOW_TIMEOUT,
  withFaces,
} from "../support/workflow";

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
  } = startWorkflows(PORTS.workflowReconstruct);

  it(
    "capture, reconstruct, complete, refine, export: the storefront banner becomes a new face, is completed from the recorded run, edited and exported",
    async () => {
      const { app, page, places } = on();
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
          .locator('.ty-reconstruct-frame[data-mark="unconfirmed"]')
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
      // Every link met on the way names a place that exists.
      await collectLinks();
      expect(linksMet()).toBeGreaterThan(NAVIGATION_LINKS);
      expect(deadLinks()).toEqual([]);
    },
    WORKFLOW_TIMEOUT
  );
});
