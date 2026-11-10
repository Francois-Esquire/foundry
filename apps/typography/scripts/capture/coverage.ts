import type { Capture } from "./context";
export default async function capture(c: Capture) {
  await c.load();
  await c.app.goto("/coverage/Latn");
  await c.page.locator(".ty-coverage-main").waitFor();
  await c.shot(
    "latin",
    "Opened Latin coverage for Lato.",
    c.page.locator(".ty-coverage-main"),
    true
  );
  await c.page
    .getByRole("searchbox", { name: "Find a character" })
    .fill("U+0061");
  const results = c.section("Search results");
  await results.getByRole("button").first().waitFor();
  await c.shot("search", "Searched for U+0061, Latin small letter a.", results);
  await results.getByRole("button").first().click();
  await c.shot(
    "inspector",
    "Selected a to inspect its source glyph.",
    c.page.getByRole("complementary", { name: "Character" })
  );
  await c.page.getByRole("searchbox", { name: "Find a character" }).fill("");
  await c.app.goto("/coverage/Deva");
  await c.shot(
    "missing",
    "Lato lacks Devanagari: offers generation and a defined subset of 15 characters, 3 forms and 9 test words.",
    c.page.locator(".ty-coverage-main"),
    true
  );
}
