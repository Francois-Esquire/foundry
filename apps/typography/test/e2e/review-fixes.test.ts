/**
 * The findings of the independent review that were found in Chrome, each
 * reproduced in the real app in Chrome and shown fixed. Nothing here calls a
 * model: glyphs come from the procedural strategy or from a recorded run.
 */
import path from "node:path";
import type { Dialog, Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppSession, FIXTURE_FONTS, startApp } from "./support/app";
import { PORTS } from "./support/ports";
import {
  BUILD_TIMEOUT,
  headedSection,
  PHONE,
  SETTLE_MS,
  WIDE,
} from "./support/screen";

const START_TIMEOUT_MS = 60_000;
const FLOW_TIMEOUT = 400_000;

const SAMPLES = [
  "Lato-Regular.ttf",
  "SofiaSans-wght.ttf",
  "NotoSansDevanagari-wdth-wght.ttf",
  "NotoNaskhArabic-wght.ttf",
  "DavidLibre-Regular.ttf",
];
const LATO = "Lato-Regular.ttf";
const MONO = "SourceCodePro-Regular.otf";
const PINNED_SOFIA = "Sofia Sans Regular, pinned at wght 400";
const BUILD = /^Build \d+ fonts?$/;
const PROPOSE_LETTERS = /^Propose \d+ letters as candidates$/;
const PROPOSE_INFERRED = /^Propose \d+ inferred letters as candidates$/;
const NO_RULE = /No rule can build (\d+) missing characters/;
const FIRST_OF = /These are the first 24 of (\d+)/;
const WAITING = /(\d+) candidates waiting/;
const CHANGED_SINCE =
  /The project has changed since AtlasSans-Regular\.ttf was built/;
const DESTINATION_GONE =
  "The face these letters were going to is no longer in the project. Choose a destination again, then propose the letters to it.";
/** A face id as the project writes it: sixteen hex digits, a colon, an index. */
const FACE_ID = /[0-9a-f]{16}:\d/;
/** The lettering of the storefront banner, in pixels of the photograph. */
const BANNER = { height: 196, width: 400, x: 432, y: 162 };
const PHOTOGRAPH = { height: 960, width: 1280 };

describe("the review's findings, in Chrome", () => {
  let app: AppSession;
  let page: Page;
  let places: Locator;

  const resize = async (size: { height: number; width: number }) => {
    await page.setViewportSize(size);
    await page.waitForTimeout(SETTLE_MS);
  };

  const statusLine = async () =>
    (await page.locator(".ty-masthead-status").innerText()).toLowerCase();

  const startEmpty = async () => {
    await resize(WIDE);
    await app.goto("/import");
    await app.reload();
    await page.getByLabel("Add font files").waitFor();
  };

  const importFiles = async (files: readonly string[]) => {
    await page
      .getByLabel("Add font files")
      .setInputFiles(files.map((file) => path.join(FIXTURE_FONTS, file)));
    for (const file of files) {
      await page
        .getByRole("table", { name: "Imported source fonts" })
        .getByRole("cell", { exact: true, name: file })
        .waitFor();
    }
  };

  const hash = () => decodeURIComponent(new URL(page.url()).hash);

  /** How far the screen scrolls sideways. Nothing may be wider than the window. */
  const sidewaysScroll = () =>
    page
      .locator("main")
      .evaluate((main) => main.scrollWidth - main.clientWidth);

  /** Every select on screen with its own right edge and its field's. */
  const selectEdges = () =>
    page.locator("main select").evaluateAll((selects) =>
      selects.map((select) => {
        const field = select.closest(".ty-field");
        const chevron = field?.querySelector(".ty-field-chevron");
        return {
          chevronRight: chevron?.getBoundingClientRect().right ?? 0,
          fieldRight: field?.getBoundingClientRect().right ?? 0,
          label: field?.querySelector("label")?.textContent ?? "",
          right: select.getBoundingClientRect().right,
          windowWidth: window.innerWidth,
        };
      })
    );

  beforeAll(async () => {
    app = await startApp({ port: PORTS.reviewFixes, ...WIDE });
    ({ page } = app);
    places = page.getByRole("navigation", { name: "Places" });
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  it("asks before a reload empties a project that holds a font, and not before", async () => {
    await app.goto("/import");
    const asked: string[] = [];
    const answer = (dialog: Dialog) => {
      asked.push(dialog.type());
      return dialog.accept();
    };
    page.on("dialog", answer);
    try {
      // An empty project has nothing to lose.
      await page.getByLabel("Add font files").waitFor();
      await page.reload();
      expect(asked).toEqual([]);

      await importFiles([LATO]);
      await page.reload();
      expect(asked).toEqual(["beforeunload"]);
      await page.getByLabel("Add font files").waitFor();
      await expect.poll(statusLine).toContain("no fonts yet");
    } finally {
      page.off("dialog", answer);
    }
    expect(app.errors).toEqual([]);
  });

  it(
    "keeps every face select inside its column at 390 wide, and tells a pinned instance from its variable face",
    async () => {
      await startEmpty();
      for (const file of SAMPLES) {
        await page.getByRole("button", { name: `Load ${file}` }).click();
        await page
          .getByRole("table", { name: "Imported source fonts" })
          .getByRole("cell", { exact: true, name: file })
          .waitFor();
      }
      // Pin an instance of Sofia Sans, which keeps its variable face's style name.
      await places.getByRole("link", { name: "Studio" }).click();
      await page
        .getByRole("combobox", { name: "Face" })
        .selectOption({ label: "Sofia Sans Regular, variable" });
      await page.getByRole("button", { name: "Pin Regular" }).click();
      await page.getByRole("application").waitFor();

      const facesIn = async (name: string) =>
        page
          .getByRole("combobox", { exact: true, name })
          .locator("option")
          .evaluateAll((options) =>
            options.map((option) => option.textContent ?? "")
          );
      const studioFaces = await facesIn("Face");
      expect(studioFaces).toContain("Sofia Sans Regular, variable");
      expect(studioFaces).toContain(PINNED_SOFIA);

      await resize(PHONE);
      const visits: readonly (readonly [string, string])[] = [
        ["Studio", "Face"],
        ["Coverage", "Face"],
        ["Generate", "Editable face"],
        ["Proof", "Font to prove"],
      ];
      for (const [place, select] of visits) {
        await places.getByRole("link", { name: place }).click();
        const control = page.getByRole("combobox", {
          exact: true,
          name: select,
        });
        // Screens load on demand, and two of them call their select "Face".
        await expect
          .poll(() => page.locator("main h1").textContent())
          .toBe(place);
        await expect.poll(() => page.locator(".ty-progress").count()).toBe(0);
        await control.waitFor();
        await page.waitForTimeout(SETTLE_MS);
        // The pinned instance says it is pinned, and where, in every list.
        const labels = await facesIn(select);
        expect(
          labels.filter((label) => label.startsWith(PINNED_SOFIA)),
          `${place}: ${labels.join(" | ")}`
        ).toHaveLength(1);
        expect(
          labels.filter((label) => label === "Sofia Sans Regular")
        ).toHaveLength(place === "Coverage" ? 1 : 0);
        expect(await sidewaysScroll()).toBeLessThanOrEqual(1);
        for (const edge of await selectEdges()) {
          expect(edge.right, `${place}: ${edge.label}`).toBeLessThanOrEqual(
            edge.fieldRight + 0.5
          );
          expect(
            edge.chevronRight,
            `${place}: chevron of ${edge.label}`
          ).toBeLessThanOrEqual(edge.windowWidth);
        }
      }
      // Generate, where the reviewer saw the select run past the edge.
      await places.getByRole("link", { name: "Generate" }).click();
      const editable = page.getByRole("combobox", { name: "Editable face" });
      expect(
        await editable.evaluate(
          (select) => getComputedStyle(select).textOverflow
        )
      ).toBe("ellipsis");
      await app.screenshot("review-390-generate");
      await resize(WIDE);
      expect(app.errors).toEqual([]);
    },
    FLOW_TIMEOUT
  );

  it(
    "generates a writing system's missing characters by rule, run after run",
    async () => {
      await startEmpty();
      await importFiles([MONO]);
      await places.getByRole("link", { name: "Generate" }).click();
      const request = headedSection(page, "Generate");
      await request.waitFor();
      await page
        .getByRole("radio", { name: "Writing system" })
        .check({ force: true });
      const targets = page.getByRole("table", {
        name: "Targets of this request and what each depends on",
      });
      // The procedural strategy is asked only for what a rule can build.
      await expect.poll(() => targets.locator("tbody tr").count()).toBe(24);
      expect(await targets.innerText()).not.toContain("No rule builds it");
      const noRule = Number((await request.innerText()).match(NO_RULE)?.[1]);
      expect(noRule).toBeGreaterThan(24);
      const buildable = Number(
        (await request.innerText()).match(FIRST_OF)?.[1]
      );
      expect(buildable).toBeGreaterThan(48);

      const run = page.getByRole("button", { name: "Generate 24 glyphs" });
      const candidates = page.locator("li.ty-generate-candidate");
      const waiting = async () =>
        Number((await statusLine()).match(WAITING)?.[1] ?? 0);

      await run.click();
      await expect.poll(() => candidates.count()).toBe(24);
      await expect.poll(waiting).toBe(24);
      const first = await candidates.evaluateAll((cells) =>
        cells.map((cell) => cell.getAttribute("data-candidate"))
      );

      // The second run is not filled by what the first could not build.
      await expect
        .poll(async () =>
          Number((await request.innerText()).match(FIRST_OF)?.[1])
        )
        .toBe(buildable - 24);
      await run.click();
      await expect.poll(waiting).toBe(48);
      const second = await candidates.evaluateAll((cells) =>
        cells.map((cell) => cell.getAttribute("data-candidate"))
      );
      expect(second).toHaveLength(24);
      expect(second.some((key) => first.includes(key))).toBe(false);

      // A strategy that draws is still asked for every missing character.
      await page
        .locator(".ty-generate-strategy")
        .filter({ hasText: "Vector model" })
        .click();
      await expect
        .poll(async () =>
          Number((await request.innerText()).match(FIRST_OF)?.[1])
        )
        .toBe(buildable - 48 + noRule);
      expect(await request.innerText()).not.toMatch(NO_RULE);
      expect(app.errors).toEqual([]);
    },
    FLOW_TIMEOUT
  );

  it(
    "prints unchanged measures in ink, and says in Proof and in Export that a built font is behind the project",
    async () => {
      await startEmpty();
      await importFiles([LATO]);
      await places.getByRole("link", { name: "Studio" }).click();
      await page.getByRole("searchbox", { name: "Find a glyph" }).fill("A");
      await page
        .getByRole("searchbox", { name: "Find a glyph" })
        .press("Enter");
      const inspector = page.getByRole("complementary", {
        name: "Measures and revisions",
      });
      const field = (name: string) =>
        inspector.getByRole("textbox", { name: `${name}, in font units` });
      const colourOf = (control: Locator) =>
        control.evaluate((element) => getComputedStyle(element).color);
      const tokens = await page.evaluate(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        const read = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const colours = { carbon: read("--carbon"), ink: read("--ink") };
        probe.remove();
        return colours;
      });
      const advance = field("Advance");
      await advance.waitFor();
      // Untouched, every measure is the source font's own, in ink.
      for (const name of ["Advance", "Left bearing", "Right bearing"]) {
        expect(await colourOf(field(name)), name).toBe(tokens.ink);
      }
      const faceId = hash().split("/")[2] ?? "";

      // The first edit: only the values it changed turn carbon.
      const sourceAdvance = Number(await advance.inputValue());
      await advance.fill(String(sourceAdvance + 60));
      await advance.press("Enter");
      await expect.poll(() => colourOf(advance)).toBe(tokens.carbon);
      expect(await colourOf(field("Right bearing"))).toBe(tokens.carbon);
      expect(await colourOf(field("Left bearing"))).toBe(tokens.ink);
      await inspector.evaluate((element) =>
        element.scrollIntoView({ block: "start" })
      );
      await app.screenshot("review-1440-studio-measures");
      await resize(PHONE);
      await inspector
        .getByRole("table")
        .first()
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await app.screenshot("review-390-studio-measures");
      await resize(WIDE);

      // Build it in Export.
      await app.goto(`/export/face/${encodeURIComponent(faceId)}`);
      await page.getByLabel("Family name").fill("Atlas Sans");
      const plan = page.getByRole("region", { exact: true, name: "Plan" });
      await expect
        .poll(() => plan.innerText())
        .toContain("AtlasSans-Regular.ttf");
      await plan.getByRole("button", { name: BUILD }).click();
      const built = page.getByTestId("built-font");
      await built.waitFor({ timeout: BUILD_TIMEOUT });
      expect(await built.getAttribute("data-stale")).toBe("false");

      // Proof of the build, while the project is as it was built.
      await built.getByRole("link", { name: "Prove this font" }).click();
      await page.getByTestId("proof-facts").waitFor();
      expect(await page.locator("main").innerText()).not.toMatch(CHANGED_SINCE);

      // The second edit, after the build.
      await places.getByRole("link", { name: "Studio" }).click();
      await advance.waitFor();
      await advance.fill(String(sourceAdvance + 120));
      await advance.press("Enter");
      await expect.poll(statusLine).toContain("2 revisions");

      // Proof opens on the old build, and now says so with the way out.
      await places.getByRole("link", { name: "Proof" }).click();
      await page.getByTestId("proof-facts").waitFor();
      const proof = page.locator("main");
      await expect.poll(() => proof.innerText()).toMatch(CHANGED_SINCE);
      expect(await proof.innerText()).toContain(
        "Build it again in Export to bring it up to date"
      );
      expect(
        await page
          .getByRole("combobox", { name: "Font to prove" })
          .locator("option:checked")
          .innerText()
      ).toContain("before the project changed");
      await proof
        .getByRole("link", { name: "Build it again in Export" })
        .click();
      // The plan that built the file is still the plan: nothing was rewritten.
      await expect.poll(hash).toBe("#/export");
      await page.getByLabel("Family name").waitFor();
      expect(await page.getByLabel("Family name").inputValue()).toBe(
        "Atlas Sans"
      );
      const stale = page.getByTestId("built-font");
      await stale.waitFor();
      expect(await stale.getAttribute("data-stale")).toBe("true");
      expect(await stale.innerText()).toMatch(CHANGED_SINCE);
      expect(app.errors).toEqual([]);
    },
    FLOW_TIMEOUT
  );

  it(
    "shows observed and inferred letters differently everywhere, and stops proposing once their face is removed",
    async () => {
      await startEmpty();
      await importFiles([LATO, "SofiaSans-wght.ttf"]);
      await places.getByRole("link", { name: "Reconstruct" }).click();
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
          box.x + (x / PHOTOGRAPH.width) * box.width,
          box.y + (y / PHOTOGRAPH.height) * box.height,
        ] as const;
      await page.mouse.move(...at(BANNER.x, BANNER.y));
      await page.mouse.down();
      await page.mouse.move(
        ...at(BANNER.x + BANNER.width / 2, BANNER.y + BANNER.height / 2),
        { steps: 4 }
      );
      await page.mouse.move(
        ...at(BANNER.x + BANNER.width, BANNER.y + BANNER.height),
        { steps: 4 }
      );
      await page.mouse.up();
      await headedSection(page, "Letters").locator("p[data-found]").waitFor();

      // Observed letters go to a new face, in brackets until they are accepted.
      const candidates = headedSection(page, "Candidates");
      await candidates.getByRole("button", { name: PROPOSE_LETTERS }).click();
      const board = candidates.getByRole("list", { name: "Observed letters" });
      await board.waitFor({ timeout: BUILD_TIMEOUT });
      const observedCount = await board.locator("li").count();
      expect(observedCount).toBeGreaterThan(5);
      expect(
        await board
          .locator('.ty-reconstruct-frame[data-mark="observed"]')
          .count()
      ).toBe(observedCount);
      expect(
        await board.locator('.ty-mark[data-kind="observed"]').count()
      ).toBe(observedCount);
      expect(await board.locator('.ty-mark[data-kind="edited"]').count()).toBe(
        0
      );
      const faceId =
        (await candidates.locator("p[data-face]").getAttribute("data-face")) ??
        "";

      // Inferred letters from the recorded run, dotted.
      const completion = headedSection(page, "Completion");
      await completion.getByRole("radio", { name: "Recorded run" }).check();
      await completion
        .getByRole("button", { name: "Infer the missing characters" })
        .click();
      await completion.locator("p[data-inferred]").waitFor();
      await completion.getByRole("button", { name: PROPOSE_INFERRED }).click();
      const inferredBoard = completion.getByRole("list", {
        name: "Inferred letters",
      });
      await expect
        .poll(() => inferredBoard.locator('li[data-status="proposed"]').count())
        .toBeGreaterThan(5);
      const inferredCount = await inferredBoard.locator("li").count();
      expect(
        await inferredBoard
          .locator('.ty-reconstruct-frame[data-mark="unconfirmed"]')
          .count()
      ).toBe(inferredCount);

      // Coverage: the two kinds do not share a frame or a name.
      await app.goto("/coverage/Latn");
      const grid = page.locator(".ty-coverage-grid");
      await grid.waitFor();
      await page
        .getByRole("combobox", { exact: true, name: "Face" })
        .selectOption(faceId);
      await expect
        .poll(() => grid.locator('button[data-state="observed"]').count())
        .toBe(observedCount);
      const inferredCells = grid.locator('button[data-state="candidate"]');
      expect(await inferredCells.count()).toBeGreaterThan(5);
      const observedCell = grid
        .locator('button[data-state="observed"]')
        .first();
      expect(await observedCell.getAttribute("aria-label")).toContain(
        "observed in the evidence, not accepted"
      );
      expect(await observedCell.locator(".ty-brackets > span").count()).toBe(4);
      expect(await inferredCells.first().getAttribute("aria-label")).toContain(
        "candidate, not accepted"
      );
      // Brackets are drawn with borders, the dotted frame with a dotted border.
      expect(
        await observedCell
          .locator(".ty-brackets > span")
          .first()
          .evaluate((corner) => getComputedStyle(corner).borderTopStyle)
      ).toBe("solid");
      expect(
        await inferredCells
          .first()
          .evaluate((cell) => getComputedStyle(cell, "::before").borderTopStyle)
      ).toBe("dotted");
      await observedCell.click();
      const inspector = page.getByRole("complementary", { name: "Character" });
      await expect
        .poll(() => inspector.innerText())
        .toContain("Observed in the evidence, not accepted.");
      await app.screenshot("review-1440-coverage-observed-inferred");
      await resize(PHONE);
      await grid.evaluate((element) =>
        element.scrollIntoView({ block: "start" })
      );
      await app.screenshot("review-390-coverage-observed-inferred");
      await resize(WIDE);

      // The Studio's candidates say the same.
      await places.getByRole("link", { name: "Studio" }).click();
      const waiting = page.locator(".ty-studio-candidates li");
      await expect
        .poll(() => waiting.count())
        .toBe(observedCount + inferredCount);
      expect(
        await page
          .locator('.ty-studio-candidate-frame[data-mark="observed"]')
          .count()
      ).toBe(observedCount);
      expect(
        await page
          .locator('.ty-studio-candidate-frame[data-mark="unconfirmed"]')
          .count()
      ).toBe(inferredCount);
      expect(
        await page
          .locator('.ty-studio-candidates .ty-mark[data-kind="edited"]')
          .count()
      ).toBe(0);

      // Remove the face these letters were going to, with its work.
      await places.getByRole("link", { name: "Import" }).click();
      await page
        .getByRole("button", {
          name: "Remove StorefrontNeededThings-Regular.ttf",
        })
        .click();
      await page.getByRole("button", { name: "Remove font and work" }).click();
      await places.getByRole("link", { name: "Reconstruct" }).click();
      const gone = headedSection(page, "Completion");
      await expect.poll(() => gone.innerText()).toContain(DESTINATION_GONE);
      expect(await gone.getByRole("button").count()).toBe(0);
      const decided = headedSection(page, "Candidates");
      expect(await decided.innerText()).toContain(DESTINATION_GONE);
      expect(
        await decided.getByRole("list", { name: "Observed letters" }).count()
      ).toBe(0);
      // No internal id anywhere on the screen, nor in a notice above it.
      expect(await page.locator("body").innerText()).not.toMatch(FACE_ID);
      // The way out works: a destination can be chosen again.
      await decided
        .getByRole("button", { name: "Choose a destination again" })
        .click();
      await decided.getByRole("button", { name: PROPOSE_LETTERS }).waitFor();
      expect(app.errors).toEqual([]);
    },
    FLOW_TIMEOUT
  );

  it("shows the observed mark and frame in the specimen, at 1440 and at 390", async () => {
    await resize(WIDE);
    await app.goto("/system");
    const marks = headedSection(page, "Marks");
    await marks.waitFor();
    expect(
      await marks.locator('.ty-mark[data-kind="observed"]').first().innerText()
    ).toBe("Observed in the evidence");
    const cells = headedSection(page, "Glyph cells");
    expect(
      await cells.locator('.ty-glyph-cell[data-state="observed"]').count()
    ).toBeGreaterThan(1);
    for (const [name, size] of [
      ["1440", WIDE],
      ["390", PHONE],
    ] as const) {
      await resize(size);
      await marks.evaluate((element) =>
        element.scrollIntoView({ block: "start" })
      );
      await app.screenshot(`review-${name}-specimen-marks`);
      await cells.evaluate((element) =>
        element.scrollIntoView({ block: "start" })
      );
      await app.screenshot(`review-${name}-specimen-cells`);
    }
    await resize(WIDE);
    expect(app.errors).toEqual([]);
  });
});
