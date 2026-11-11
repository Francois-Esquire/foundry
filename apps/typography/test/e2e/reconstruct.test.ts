/**
 * The Reconstruct place's acceptance, in the real app in Chrome: open the
 * storefront photograph, mark the banner, and see letters found and labelled,
 * outlines recovered with fit scores, candidates accepted as revisions on a
 * new face, one accepted letter edited in the Studio, the missing alphabet
 * inferred from the recorded run, and the photograph's bytes unchanged.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppSession, FIXTURE_FONTS, startApp } from "./support/app";
import { PORTS } from "./support/ports";
import { headedSection } from "./support/screen";

const START_TIMEOUT_MS = 60_000;
const STOREFRONT = path.join(
  import.meta.dirname,
  "../fixtures/evidence/storefront-needed-things.jpg"
);
const LIBRARY = ["Lato-Regular.ttf", "SofiaSans-wght.ttf"].map((file) =>
  path.join(FIXTURE_FONTS, file)
);
/** The lettering of the banner, inside the banner's edge, in pixels of the photograph. */
const BANNER = { height: 196, width: 400, x: 432, y: 162 };
const PHOTOGRAPH = { height: 960, width: 1280 };
const READS = "NEEDEDTHINGSFORSALE";
const DISTINCT = new Set(READS).size;
const FAMILY = "Storefront Needed Things";
const NEW_ADVANCE = 640;
const COPPER_FILE = path.join(
  import.meta.dirname,
  "../fixtures/evidence/ozark-copper-letters.jpg"
);
/** The copper letters, seen at an angle: its size, and four corners placed out of order. */
const COPPER = { height: 341, width: 963 };
const COPPER_CORNERS = [
  [945, 205],
  [15, 115],
  [12, 250],
  [940, 82],
] as const;

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const numberOf = async (locator: Locator, attribute: string) =>
  Number(await locator.getAttribute(attribute));

/** Drags a rectangle over a region of the photograph, given in its own pixels. */
const dragOver = async (
  page: Page,
  picture: Locator,
  region: typeof BANNER
) => {
  await picture.scrollIntoViewIfNeeded();
  const box = await picture.boundingBox();
  if (!box) {
    throw new Error("The photograph is not on screen.");
  }
  const at = (x: number, y: number) =>
    [
      box.x + (x / PHOTOGRAPH.width) * box.width,
      box.y + (y / PHOTOGRAPH.height) * box.height,
    ] as const;
  await page.mouse.move(...at(region.x, region.y));
  await page.mouse.down();
  await page.mouse.move(
    ...at(region.x + region.width / 2, region.y + region.height / 2),
    { steps: 4 }
  );
  await page.mouse.move(
    ...at(region.x + region.width, region.y + region.height),
    { steps: 4 }
  );
  await page.mouse.up();
};

describe("Reconstruct in Chrome", () => {
  let app: AppSession;

  beforeAll(async () => {
    app = await startApp({ port: PORTS.reconstruct });
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  const shoot = async (name: string, heading: string) => {
    await headedSection(app.page, heading).evaluate((element) =>
      element.scrollIntoView({ block: "start" })
    );
    await app.screenshot(`reconstruct-e2e-${name}`);
  };

  it("recovers the storefront banner into a new face, edits a letter in the Studio and leaves the photograph untouched", async () => {
    const { page } = app;
    const places = page.getByRole("navigation", { name: "Places" });

    // A library to read the letters against.
    await places.getByRole("link", { name: "Import" }).click();
    await page.locator('input[type="file"]').setInputFiles(LIBRARY);
    await page
      .getByRole("cell", { exact: true, name: "SofiaSans-wght.ttf" })
      .first()
      .waitFor();

    // Open the storefront photograph.
    await places.getByRole("link", { name: "Reconstruct" }).click();
    const openStorefront = page.getByRole("button", {
      name: "Open storefront banner",
    });
    await openStorefront.waitFor();
    await app.screenshot("reconstruct-e2e-01-empty");
    await openStorefront.click();
    const picture = page.locator("svg.ty-reconstruct-marking");
    await picture.waitFor();
    const digest = await headedSection(page, "Evidence")
      .locator("span[title]")
      .getAttribute("title");
    expect(digest).toBe(sha256(readFileSync(STOREFRONT)));

    // Mark the banner.
    await dragOver(page, picture, BANNER);
    const letters = headedSection(page, "Letters");
    const found = letters.locator("p[data-found]");
    await found.waitFor();
    await shoot("02-region", "Region");
    await shoot("03-isolation", "Isolation");

    // Letters are found, boxed and labelled.
    expect(await numberOf(found, "data-found")).toBe(READS.length);
    expect(await numberOf(found, "data-labelled")).toBeGreaterThan(14);
    const cells = letters.locator("li.ty-reconstruct-letter");
    await expect.poll(() => cells.count()).toBe(READS.length);
    expect(await letters.locator("path.ty-reconstruct-line").count()).toBe(
      READS.length
    );
    expect(await letters.locator("text.ty-reconstruct-tag").count()).toBe(
      READS.length
    );
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
      (letter, index) => letter === READS[index]
    ).length;
    // The recogniser is not asked to be perfect, only to have read most of it.
    expect(right).toBeGreaterThan(READS.length / 2);
    await shoot("04-letters", "Letters");

    // A label is corrected by typing over it: mislabel the first letter, then put it right.
    const first = cells.first();
    await first.getByRole("textbox").fill("X");
    await expect
      .poll(() => first.getAttribute("data-labelled-by"))
      .toBe("person");
    await expect.poll(readAs).toBe(`X${machine.slice(1)}`);
    // Then correct every label that is wrong.
    for (const [index, letter] of [...READS].entries()) {
      if (index === 0 || machine[index] !== letter) {
        await cells.nth(index).getByRole("textbox").fill(letter);
        await expect
          .poll(() => cells.nth(index).getAttribute("data-labelled-by"))
          .toBe("person");
      }
    }
    await expect.poll(readAs).toBe(READS);
    await expect
      .poll(() => numberOf(found, "data-labelled"))
      .toBe(READS.length);

    // Nearest faces are worded as resemblance, never as identity.
    await letters.getByText("It does not identify the typeface.").waitFor();
    expect(
      await letters.getByRole("table").getByRole("rowheader").count()
    ).toBeGreaterThan(1);

    // Outlines are recovered, each with a fit score, and laid over the photograph.
    const outlines = headedSection(page, "Outlines");
    const traced = outlines.locator("p[data-traced]");
    await expect.poll(() => numberOf(traced, "data-traced")).toBe(READS.length);
    expect(await numberOf(traced, "data-distinct")).toBe(DISTINCT);
    const fits = outlines.locator("li.ty-reconstruct-fit");
    expect(await fits.count()).toBe(DISTINCT);
    for (const fit of await fits.all()) {
      expect(await numberOf(fit, "data-fit")).toBeGreaterThan(0.8);
    }
    const opacity = outlines.getByRole("slider", { name: "Outline opacity" });
    const outlineOpacity = () =>
      outlines
        .locator("path.ty-reconstruct-outline")
        .first()
        .evaluate((outline) => Number(getComputedStyle(outline).fillOpacity));
    expect(await outlineOpacity()).toBeCloseTo(0.5, 5);
    await opacity.focus();
    await page.keyboard.press("Home");
    await expect.poll(outlineOpacity).toBe(0);
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(outlineOpacity).toBeCloseTo(0.55, 5);
    await shoot("05-outlines", "Outlines");

    // Propose them to a new face made for this reconstruction.
    const candidates = headedSection(page, "Candidates");
    expect(
      await candidates
        .getByRole("textbox", { name: "Family name of the new face" })
        .inputValue()
    ).toBe(FAMILY);
    await candidates
      .getByRole("button", {
        name: `Propose ${DISTINCT} letters as candidates`,
      })
      .click();
    const board = candidates.getByRole("list", { name: "Observed letters" });
    await board.waitFor();
    await expect
      .poll(() => board.locator('li[data-status="proposed"]').count())
      .toBe(DISTINCT);
    expect(await board.locator('li[data-basis="observed"]').count()).toBe(
      DISTINCT
    );
    // Observed letters not yet accepted are framed in corner brackets: never
    // the dotted frame of inferred work, nor the solid one of work in the face.
    expect(
      await board.locator('.ty-reconstruct-frame[data-mark="observed"]').count()
    ).toBe(DISTINCT);
    expect(
      await board.locator(".ty-reconstruct-frame .ty-brackets").count()
    ).toBe(DISTINCT);
    const standing = candidates.locator("p[data-revisions]");
    expect(await numberOf(standing, "data-revisions")).toBe(0);
    await shoot("06-proposed", "Candidates");

    // Accepting them creates one revision each on the chosen face.
    await board.getByRole("button", { name: "Reject G" }).click();
    await candidates
      .getByRole("button", {
        name: `Accept all ${DISTINCT - 1} proposed letters`,
      })
      .click();
    await expect
      .poll(() => numberOf(standing, "data-revisions"))
      .toBe(DISTINCT - 1);
    expect(await numberOf(standing, "data-accepted")).toBe(DISTINCT - 1);
    expect(await board.locator('li[data-status="rejected"]').count()).toBe(1);
    // Accepted, a letter takes the solid frame of work in the face.
    expect(
      await board.locator('.ty-reconstruct-frame[data-mark="edited"]').count()
    ).toBe(DISTINCT - 1);
    const faceId = await standing.getAttribute("data-face");
    await shoot("07-accepted", "Candidates");

    // Complete the alphabet from the recorded run. Everything it draws is inferred.
    const completion = headedSection(page, "Completion");
    await completion.getByRole("radio", { name: "Recorded run" }).check();
    await completion
      .getByRole("button", { name: "Infer the missing characters" })
      .click();
    const inferred = completion.locator("p[data-inferred]");
    await inferred.waitFor();
    expect(await inferred.getAttribute("data-recorded")).toBe("true");
    const drawn = await numberOf(inferred, "data-inferred");
    expect(drawn).toBeGreaterThan(10);
    await completion.getByText("Not live model output.").first().waitFor();
    const inferredBoard = completion.getByRole("list", {
      name: "Inferred letters",
    });
    expect(
      await inferredBoard.locator('li[data-basis="inferred"]').count()
    ).toBe(drawn);
    expect(
      await inferredBoard
        .locator('.ty-reconstruct-frame[data-mark="unconfirmed"]')
        .count()
    ).toBe(drawn);
    await completion
      .getByRole("button", {
        name: "Fit their width to the observed letters",
      })
      .click();
    await completion
      .getByRole("button", {
        name: `Propose ${drawn} inferred letters as candidates`,
      })
      .click();
    await expect
      .poll(() => inferredBoard.locator('li[data-status="proposed"]').count())
      .toBe(drawn);
    await shoot("08-completion", "Completion");

    // One accepted letter opens in the Studio and can be edited.
    await board.getByRole("link", { name: "Open N in the Studio" }).click();
    const drawing = page.getByRole("application");
    await drawing.waitFor();
    expect(page.url()).toContain(encodeURIComponent(faceId ?? "none"));
    const inspector = page.getByRole("complementary", {
      name: "Measures and revisions",
    });
    const revisions = inspector.locator("ol.ty-studio-revisions");
    await expect
      .poll(() => numberOf(revisions, "data-revisions"))
      .toBe(DISTINCT - 1);
    const outlineBefore = await page
      .locator("path.ty-studio-edit")
      .getAttribute("d");
    expect(outlineBefore).toBeTruthy();
    await app.screenshot("reconstruct-e2e-09-studio");
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
    expect(Number(await advance.inputValue())).not.toBe(NEW_ADVANCE);
    await advance.fill(String(NEW_ADVANCE));
    await advance.press("Enter");
    await expect
      .poll(() => numberOf(revisions, "data-revisions"))
      .toBe(DISTINCT + 1);
    await app.screenshot("reconstruct-e2e-10-studio-edited");

    // Back in Reconstruct everything is still there, and the photograph is byte for byte what came in.
    await places.getByRole("link", { name: "Reconstruct" }).click();
    await board.waitFor();
    expect(await numberOf(standing, "data-revisions")).toBe(DISTINCT + 1);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .getByRole("button", { name: "Export the original photograph" })
        .click(),
    ]);
    expect(download.suggestedFilename()).toBe(path.basename(STOREFRONT));
    expect(sha256(readFileSync(await download.path()))).toBe(
      sha256(readFileSync(STOREFRONT))
    );

    // The same screen on a phone.
    await page.setViewportSize({ height: 844, width: 390 });
    await shoot("11-narrow-region", "Region");
    await shoot("11b-narrow-isolation", "Isolation");
    await shoot("12-narrow-letters", "Letters");
    await shoot("12b-narrow-outlines", "Outlines");
    await shoot("13-narrow-candidates", "Candidates");
    await shoot("13b-narrow-completion", "Completion");
    // Nothing is wider than the phone.
    expect(
      await page
        .locator("main")
        .evaluate((main) => main.scrollWidth - main.clientWidth)
    ).toBeLessThanOrEqual(1);

    // On black tape the isolated lettering is printed again in that theme's ink.
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.getByRole("button", { name: "Black tape" }).click();
    await shoot("16-black-isolation", "Isolation");
    const inkIsLight = await headedSection(page, "Isolation")
      .locator("canvas")
      .last()
      .evaluate((canvas) => {
        const { data } = (canvas as HTMLCanvasElement)
          .getContext("2d")
          ?.getImageData(0, 0, canvas.clientWidth, canvas.clientHeight) ?? {
          data: [],
        };
        let lightest = 0;
        for (let at = 0; at < data.length; at += 4) {
          if ((data[at + 3] ?? 0) > 200) {
            lightest = Math.max(lightest, data[at] ?? 0);
          }
        }
        return lightest > 200;
      });
    expect(inkIsLight).toBe(true);
    // The same toggle, pressed again, goes back to white tape.
    await page.getByRole("button", { name: "Black tape" }).click();

    expect(app.errors).toEqual([]);
  });

  it("straightens lettering seen at an angle from four corners, and takes the region from the keyboard", async () => {
    const { page } = app;
    // A fresh page, so this stands alone: no fonts, no evidence.
    await page.setViewportSize({ height: 900, width: 1440 });
    // The project holds the fonts of the test before, so the app asks first.
    await app.reload();
    await page
      .getByRole("navigation", { name: "Places" })
      .getByRole("link", { name: "Reconstruct" })
      .click();
    // This photograph is brought in as a chosen file, not as a sample.
    await page.locator('input[type="file"]').setInputFiles(COPPER_FILE);
    const picture = page.locator("svg.ty-reconstruct-marking");
    await picture.waitFor();
    const region = headedSection(page, "Region");

    // Place the four corners out of order: they are read in reading order.
    await region.getByRole("radio", { name: "Four corners" }).check();
    await picture.scrollIntoViewIfNeeded();
    const box = await picture.boundingBox();
    if (!box) {
      throw new Error("The photograph is not on screen.");
    }
    for (const [x, y] of COPPER_CORNERS) {
      await page.mouse.click(
        box.x + (x / COPPER.width) * box.width,
        box.y + (y / COPPER.height) * box.height
      );
    }
    await region.getByText("The region straightened:").waitFor();
    await region
      .getByRole("img", { name: "The marked region, straightened" })
      .waitFor();
    const number = (name: string) =>
      region.getByRole("spinbutton", { exact: true, name });
    const near = async (name: string, expected: number) =>
      expect(
        Math.abs(Number(await number(name).inputValue()) - expected)
      ).toBeLessThanOrEqual(2);
    await near("Top left x", 15);
    await near("Top left y", 115);
    await near("Bottom right x", 945);
    await near("Bottom left y", 250);

    // The same region from the keyboard: type a number and press Enter.
    await number("Top left y").fill("100");
    await number("Top left y").press("Enter");
    await expect.poll(() => number("Top left y").inputValue()).toBe("100");
    // A number that would make the corners cross is refused, with the way out.
    await number("Top left x").fill("960");
    await number("Top left x").press("Enter");
    await region
      .getByText("That number does not leave a region inside the photograph.")
      .waitFor();
    await expect.poll(() => number("Top left x").inputValue()).toBe("15");

    // The separation follows its controls.
    const isolation = headedSection(page, "Isolation");
    await isolation
      .getByRole("img", {
        name: "The lettering of the region, isolated from its ground",
      })
      .waitFor();
    await isolation.getByRole("radio", { name: "Tone" }).check();
    await isolation.getByText("tone", { exact: true }).waitFor();
    await isolation.getByRole("radio", { name: "Lighter" }).check();
    await isolation
      .getByText("lighter than the ground, as you set it")
      .waitFor();
    await headedSection(page, "Region").evaluate((element) =>
      element.scrollIntoView({ block: "start" })
    );
    await app.screenshot("reconstruct-e2e-14-four-corners");
    await isolation.evaluate((element) =>
      element.scrollIntoView({ block: "start" })
    );
    await app.screenshot("reconstruct-e2e-15-four-corners-isolation");

    expect(app.errors).toEqual([]);
  });
});
