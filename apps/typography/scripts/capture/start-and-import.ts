import type { Capture } from "./context";

const MATCH_1 = /sample fonts/i;
export default async function capture(c: Capture) {
  await c.section("Start").waitFor();
  await c.shot(
    "empty",
    "An empty project offers font import and reconstruction.",
    undefined,
    true
  );
  await c.page.getByRole("button", { name: MATCH_1 }).first().click();
  await c.page.getByRole("table", { name: "Imported source fonts" }).waitFor();
  await c.shot(
    "samples",
    "Loaded the sample fonts; the project table lists their original files.",
    undefined,
    true
  );
}
