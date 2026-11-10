import type { Capture } from "./context";

const MATCH_1 = /U\+0061 LATIN SMALL LETTER A/;
export default async function capture(c: Capture) {
  await c.load();
  await c.app.goto("/studio");
  const find = c.page.getByRole("searchbox", { name: "Find a glyph" });
  await find.fill("a");
  await find.press("Enter");
  await c.page.getByText(MATCH_1).waitFor();
  await c.page.getByRole("textbox", { name: "Specimen text" }).fill("banana");
  await c.shot(
    "opened",
    "Opened a in the Studio with banana in the specimen.",
    undefined,
    true
  );
  await c.page.getByRole("application").focus();
  await c.page.keyboard.press("PageDown");
  await c.page.keyboard.press("Shift+ArrowRight");
  await c.shot("node", "Moved a selected outline node ten units to the right.");
  const advance = c.page.getByRole("textbox", {
    name: "Advance, in font units",
  });
  await advance.fill("1300");
  await advance.press("Enter");
  await c.shot(
    "advance",
    "Changed the advance to 1300; the banana specimen follows.",
    c.section("Specimen")
  );
  await c.page
    .getByRole("radio", { name: "Beside source" })
    .check({ force: true });
  await c.shot(
    "comparison",
    "Compared the edited outline beside its unchanged source.",
    undefined,
    true
  );
  await c.shot(
    "history",
    "The measures and revisions record the node and advance changes.",
    c.page.getByRole("complementary", { name: "Measures and revisions" })
  );
  await c.page
    .getByRole("complementary", { name: "Measures and revisions" })
    .getByRole("button", { exact: true, name: "Undo" })
    .click();
  await c.shot(
    "undo",
    "Undid the advance change; the outline revision remains."
  );
}
