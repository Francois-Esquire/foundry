import type { Capture } from "./context";
export default async function capture(c: Capture) {
  await c.load();
  await c.app.goto("/generate");
  await c.page
    .getByRole("radio", { exact: true, name: "Recorded run" })
    .check({ force: true });
  for (const kind of ["image", "vector"]) {
    const model =
      kind === "image"
        ? "openai/gpt-image-2.6/flare/edit"
        : "ideogram/vector/text-to-vector";
    await c.page
      .getByRole("combobox", { name: "Recorded run to replay" })
      .selectOption(`2026-11-10-latin-holdout#${kind}-model`);
    await c.page
      .getByRole("button", { exact: true, name: "Replay the recorded run" })
      .click();
    await c.page.locator("li.ty-generate-candidate").first().waitFor();
    await c.page
      .locator("[data-run-source]")
      .filter({ hasText: model })
      .waitFor();
    await c.shot(
      `${kind}-record`,
      `Replayed the recorded ${kind} model Latin holdout; no live model was called.`,
      c.section("Run record"),
      false,
      { model, source: "recorded" }
    );
    await c.shot(
      `${kind}-curves`,
      kind === "image"
        ? "Recorded image-model sheet traced into candidate outlines."
        : "Recorded vector-model candidates retain the model's own curves.",
      c.page.locator("li.ty-generate-candidate").first(),
      true,
      { model, source: "recorded" }
    );
  }
}
