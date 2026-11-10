import type { Capture } from "./context";

const MATCH_1 = /Show Sofia Sans/;
const MATCH_2 = /^liga/;
export default async function capture(c: Capture) {
  await c.load();
  await c.load("SofiaSans-wght.ttf");
  await c.app.goto("/library");
  await c.section("Face").waitFor();
  await c.shot("face", "Opened Lato's face sheet.", c.section("Face"), true);
  await c.page
    .getByRole("textbox", { name: "Specimen text" })
    .fill("office affinity Hamburg");
  await c.shot(
    "specimen",
    "Set a specimen in the face's font.",
    c.section("Text set in the face")
  );
  await c.page.getByRole("button", { name: MATCH_1 }).click();
  await c.page.getByRole("slider", { name: "Weight" }).focus();
  await c.page.keyboard.press("End");
  await c.shot(
    "weight",
    "Moved Sofia Sans to its heaviest weight, 1000.",
    c.page.getByRole("slider", { name: "Weight" }).locator("../.."),
    true
  );
  await c.page.getByRole("button", { name: MATCH_2 }).click();
  await c.shot(
    "feature",
    "Switched the liga layout feature in the specimen.",
    c.page.getByRole("button", { name: MATCH_2 }).locator("..")
  );
}
