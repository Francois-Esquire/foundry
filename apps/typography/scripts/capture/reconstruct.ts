import type { Capture } from "./context";

const MATCH_1 = /Propose \d+ letters as candidates/;
const MATCH_2 = /Accept all \d+ proposed letters/;
export default async function capture(c: Capture) {
  await c.load();
  await c.load("SofiaSans-wght.ttf");
  await c.app.goto("/reconstruct");
  await c.page.getByRole("button", { name: "Open storefront banner" }).click();
  const picture = c.page.locator("svg.ty-reconstruct-marking");
  await picture.waitFor();
  await c.shot(
    "photograph",
    "Opened the original storefront photograph.",
    c.section("Region"),
    true
  );
  await picture.scrollIntoViewIfNeeded();
  const box = await picture.boundingBox();
  if (!box) {
    throw new Error("Photograph is not visible.");
  }
  const at = (x: number, y: number) =>
    [box.x + (x / 1280) * box.width, box.y + (y / 960) * box.height] as const;
  await c.page.mouse.move(...at(432, 162));
  await c.page.mouse.down();
  await c.page.mouse.move(...at(832, 358), { steps: 8 });
  await c.page.mouse.up();
  const letters = c.section("Letters");
  await letters.locator("p[data-found]").waitFor();
  await c.shot(
    "region",
    "Marked the storefront banner as the reconstruction region.",
    c.section("Region")
  );
  await c.shot(
    "isolation",
    "Isolated the lettering from the photograph's ground.",
    c.section("Isolation")
  );
  await c.shot(
    "read",
    "Read the isolated letters against the imported faces.",
    letters
  );
  const cells = letters.locator("li.ty-reconstruct-letter");
  const reads = "NEEDEDTHINGSFORSALE";
  await cells.first().getByRole("textbox").fill("X");
  for (const [index, letter] of [...reads].entries()) {
    await cells.nth(index).getByRole("textbox").fill(letter);
  }
  await c.shot(
    "corrected",
    "Corrected the first letter label from X to N; the banner reads NEEDED THINGS FOR SALE.",
    cells.first()
  );
  await c.shot(
    "outlines",
    "Recovered outlines over the photograph, with fit scores.",
    c.section("Outlines")
  );
  const candidates = c.section("Candidates");
  await c.shot(
    "destination",
    "Chose the new Storefront Needed Things face as the destination.",
    candidates
  );
  await candidates.getByRole("button", { name: MATCH_1 }).click();
  const board = candidates.getByRole("list", { name: "Observed letters" });
  await board.waitFor();
  await c.shot(
    "observed",
    "Observed letter candidates have corner brackets: they were traced from evidence.",
    board,
    true
  );
  await candidates.getByRole("button", { name: MATCH_2 }).click();
  const completion = c.section("Completion");
  await completion
    .getByRole("radio", { exact: true, name: "Recorded run" })
    .check({ force: true });
  await completion
    .getByRole("button", { name: "Infer the missing characters" })
    .click();
  await completion.locator("p[data-inferred]").waitFor();
  await c.shot(
    "alphabet",
    "Completed the missing alphabet from a recorded run. Inferred letters have dotted frames and were not seen in the photograph.",
    completion.getByRole("list", { name: "Inferred letters" }),
    false,
    { model: "ideogram/vector/text-to-vector", source: "recorded" }
  );
  if (c.live) {
    await completion
      .getByRole("radio", { exact: true, name: "Vector model" })
      .check({ force: true });
    await completion
      .getByRole("textbox", { name: "Characters to infer" })
      .fill("B C J");
    await c.pasteKey();
    await c.shot(
      "live-key",
      "Requested three missing letters with the vector model; the pasted key stays masked.",
      completion
    );
    c.asking("B C J");
    await completion
      .getByRole("button", { name: "Infer the missing characters" })
      .click();
    await c.page
      .getByRole("button", { exact: true, name: "Stop" })
      .waitFor({ state: "hidden", timeout: 240_000 });
    const failure = completion.getByRole("alert");
    const failed = (await failure.count()) > 0;
    if (failed) {
      c.problem(
        `The live vector completion failed. ${await failure.innerText()}`
      );
    }
    const call = c.calls.at(-1);
    await c.shot(
      "live-completion",
      failed
        ? "Live vector completion failed; the app shows the provider reason. No live output was made."
        : "Live vector completion produced inferred letters that were not in the photograph.",
      completion,
      false,
      failed
        ? undefined
        : { latencyMs: call?.latencyMs, model: call?.model, source: "live" }
    );
  }
  await board.getByRole("link", { name: "Open N in the Studio" }).click();
  await c.page.getByRole("application").focus();
  await c.page.keyboard.press("PageDown");
  await c.page.keyboard.press("Shift+ArrowRight");
  const advance = c.page.getByRole("textbox", {
    name: "Advance, in font units",
  });
  await advance.fill("640");
  await advance.press("Enter");
  await c.shot(
    "edited",
    "Edited the observed N's outline and advance in the Studio."
  );
}
