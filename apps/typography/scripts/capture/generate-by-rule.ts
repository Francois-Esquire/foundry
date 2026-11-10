import type { Capture } from "./context";

const MATCH_1 = /Studio/;
export default async function capture(c: Capture) {
  await c.load();
  await c.app.goto("/generate");
  await c.page
    .getByRole("textbox", { exact: true, name: "Characters" })
    .fill("é è ñ");
  await c.shot(
    "request",
    "Requested three accented letters as a procedural holdout test.",
    c.section("Generate"),
    true
  );
  await c.page.getByRole("button", { name: "Generate 3 glyphs" }).click();
  const candidate = c.page.locator("li.ty-generate-candidate").first();
  await candidate.waitFor();
  const output = { source: "built by rule" } as const;
  await c.shot(
    "evaluation",
    "Rule-built candidates show their evaluation and agreement with the source.",
    candidate,
    true,
    output
  );
  await candidate
    .getByRole("button", { exact: true, name: "Accept é" })
    .click();
  await c.shot(
    "accepted",
    "Accepted é as a revision in the face.",
    candidate,
    false,
    output
  );
  await candidate.getByRole("link", { name: MATCH_1 }).click();
  await c.page.getByRole("application").waitFor();
  await c.shot(
    "studio",
    "Opened the accepted rule-built é in the Studio.",
    undefined,
    false,
    output
  );
}
