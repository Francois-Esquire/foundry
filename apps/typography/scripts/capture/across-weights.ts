import type { Capture } from "./context";
export default async function capture(c: Capture) {
  await c.load("SofiaSans-wght.ttf");
  await c.app.goto("/library");
  await c.shot(
    "variable",
    "Opened the variable Sofia Sans face before generating across weights.",
    c.section("Face")
  );
  await c.page.getByRole("link", { name: "Generate across weights" }).click();
  await c.page
    .getByRole("textbox", { exact: true, name: "Characters" })
    .fill("ĉ ĝ ũ Ĥ");
  await c.shot(
    "three-weights",
    "Requested the same four letters at weights 1, 400 and 1000.",
    c.page.getByTestId("family-weights"),
    true
  );
  await c.page
    .getByRole("button", { name: "Generate 4 glyphs at 3 weights" })
    .click();
  const board = c.section("Candidates across weights");
  await c.page.locator("li.ty-family-character").first().waitFor();
  const output = { source: "built by rule" } as const;
  await c.shot(
    "candidates",
    "Rule-built variants appear side by side at three weights.",
    board,
    true,
    output
  );
  await board
    .getByRole("button", {
      name: "Accept everything that is compatible (4 characters)",
    })
    .click();
  await c.shot(
    "accepted",
    "Accepted the compatible characters across the three pinned weights.",
    board,
    false,
    output
  );
  await c.page
    .getByRole("link", { name: "Plan an export of the pinned instances" })
    .click();
  await c.page
    .getByLabel("Family name", { exact: true })
    .fill("Sofia Extended");
  const variable = c.section("Variable font");
  await variable
    .getByRole("radio", { name: "One variable font" })
    .check({ force: true });
  await c.shot(
    "variable-plan",
    "Planned one variable font from the three pinned masters.",
    variable
  );
  await variable
    .getByRole("button", { name: "Build the variable font" })
    .click();
  await c.page.getByTestId("built-variable-font").waitFor({ timeout: 240_000 });
  await c.shot(
    "built",
    "Built the variable font; only checks that ran are counted as passed.",
    c.page.getByTestId("built-variable-font"),
    false,
    output
  );
}
