import type { Capture } from "./context";

const MATCH_1 = /Prove/;
const SMALL_A = /U\+0061 LATIN SMALL LETTER A/;
export default async function capture(c: Capture) {
  await c.load();
  await c.app.goto("/studio");
  const find = c.page.getByRole("searchbox", { name: "Find a glyph" });
  await find.fill("a");
  await find.press("Enter");
  await c.page.getByText(SMALL_A).waitFor();
  const advance = c.page.getByRole("textbox", {
    name: "Advance, in font units",
  });
  await advance.fill("1300");
  await advance.press("Enter");
  await c.page.getByRole("link", { name: MATCH_1 }).click();
  await c.page.getByRole("button", { name: "Build and prove" }).click();
  await c.section("In text").waitFor({ timeout: 150_000 });
  await c.page
    .getByRole("textbox", { name: "Proof text" })
    .fill("banana office affinity");
  await c.shot(
    "text",
    "Built the edited face and set it beside its source.",
    c.section("In text"),
    true
  );
  await c.shot(
    "shaping",
    "The shaping table compares the built font with its source.",
    c.section("Shaping tests")
  );
  await c.shot(
    "pixels",
    "Pixel comparison highlights differences between the built font and source.",
    c.section("Pixel comparison"),
    true
  );
  await c.shot(
    "changed",
    "Changed glyphs are read back from the built bytes.",
    c.section("Changed glyphs")
  );
}
