import type { Capture } from "./context";

const MATCH_1 = /^Basic Latin/;
const MATCH_2 = /^Build \d+ fonts?$/;
const MATCH_3 = /^Download/;
export default async function capture(c: Capture) {
  await c.load();
  await c.app.goto("/export");
  const characters = c.section("Characters");
  await characters
    .getByRole("radio", { name: "A selection" })
    .check({ force: true });
  await characters
    .getByRole("checkbox", { name: MATCH_1 })
    .check({ force: true });
  await c.page.getByLabel("Family name", { exact: true }).fill("Lato Subset");
  await c.shot(
    "blocked",
    "The reserved Lato name blocks the derived-font export plan.",
    c.section("Plan"),
    true
  );
  await c.page.getByLabel("Family name", { exact: true }).fill("Atlas Sans");
  await c.shot(
    "renamed",
    "Renamed the derived family to Atlas Sans; the export plan can now build.",
    c.section("Plan")
  );
  await c.section("Plan").getByRole("button", { name: MATCH_2 }).click();
  const built = c.page.getByTestId("built-font");
  await built.waitFor({ timeout: 150_000 });
  await c.shot(
    "built",
    "Built Atlas Sans: the result lists its six validation checks.",
    built,
    true
  );
  const [download] = await Promise.all([
    c.page.waitForEvent("download"),
    built.getByRole("button", { name: MATCH_3 }).click(),
  ]);
  if (await download.failure()) {
    throw new Error("Derived download failed.");
  }
  await c.shot(
    "download",
    `Downloaded ${download.suggestedFilename()} from the built result.`,
    built
  );
  await c.app.goto("/library");
  const [original] = await Promise.all([
    c.page.waitForEvent("download"),
    c.page.getByRole("button", { name: "Export original" }).click(),
  ]);
  if (await original.failure()) {
    throw new Error("Original download failed.");
  }
  await c.shot(
    "original",
    "Exported the unchanged original Lato-Regular.ttf from the face sheet.",
    c.section("Face")
  );
}
