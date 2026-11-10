import type { Capture } from "./context";

const MATCH_1 = /Prove/;
export default async function capture(c: Capture) {
  await c.load();
  await c.app.goto("/generate");
  const offer = c.page.locator("output").filter({ hasText: "on offer" });
  await c.shot(
    "offer",
    "The offer defines a subset of 15 characters, 3 forms and 9 words, not support for Devanagari.",
    offer,
    true
  );
  await offer.getByRole("link", { name: "Open the script extension" }).click();
  await c.shot(
    "plan",
    "Opened the subset plan with glyphs, shaping forms and test words.",
    c.section("Plan")
  );
  await c.page
    .getByRole("button", { exact: true, name: "Replay the recorded run" })
    .click();
  await c.page.locator("[data-extension-result]").waitFor();
  const output = {
    model: "ideogram/vector/text-to-vector",
    source: "recorded",
  } as const;
  await c.shot(
    "replay",
    "Replayed the recorded subset run; its steps report what was made.",
    c.section("Run"),
    false,
    output
  );
  await c.shot(
    "review",
    "Reviewed the recorded subset glyphs and their evaluation before adding anything.",
    c.section("Result"),
    true,
    output
  );
  await c.page
    .getByRole("button", { name: "Add the whole extension to Lato Regular" })
    .click();
  await c.shot(
    "added",
    "Added the whole defined subset as one revision.",
    c.section("Add to the face"),
    false,
    output
  );
  await c.page.getByRole("button", { name: "Build and verify" }).click();
  await c.page
    .locator("[data-extension-verification]")
    .waitFor({ timeout: 150_000 });
  await c.shot(
    "verification",
    "Built and verified the subset; the screen distinguishes checks that ran from those that did not.",
    c.section("Verification"),
    false,
    output
  );
  await c.shot(
    "nine-words",
    "The nine test words drawn from the built font, with their planned glyph sequences.",
    c.page.getByRole("list", {
      name: "Test words in the built font's own outlines",
    }),
    false,
    output
  );
  await c.section("Next").getByRole("link", { name: MATCH_1 }).click();
  await c.page.getByRole("button", { name: "Build and prove" }).click();
  await c.section("In text").waitFor({ timeout: 150_000 });
  await c.shot(
    "proof",
    "Set the subset's words in Proof beside the source.",
    c.section("In text"),
    false,
    output
  );
}
