import type { Capture } from "./context";

const CHARACTERS = "é è ñ";

/**
 * One live run in Generate with the vector or the image model. Each is its own
 * flow, so one can be retaken without paying for the other.
 */
export default function generateLive(kind: "Image" | "Vector") {
  const model = kind.toLowerCase();
  return async (c: Capture) => {
    await c.load();
    await c.app.goto("/generate");
    await c.page
      .getByRole("textbox", { exact: true, name: "Characters" })
      .fill(CHARACTERS);
    await c.page
      .getByRole("radio", { exact: true, name: `${kind} model` })
      .check({ force: true });
    await c.pasteKey();
    await c.shot(
      "key",
      `Typed the fal key into the masked field. The ${model} model's estimate is shown before a paid run.`,
      c.page.getByLabel("fal API key", { exact: true }).locator("../.."),
      true
    );
    c.asking(
      kind === "Image" ? `${CHARACTERS}, at the lowest quality` : CHARACTERS
    );
    await c.page.getByRole("button", { name: "Generate 3 glyphs" }).click();
    await c.shot(
      "stages",
      `Started the live ${model} model run. The stages show its progress.`,
      c.section("Run")
    );
    await c.page
      .getByRole("button", { exact: true, name: "Stop the run" })
      .waitFor({ state: "hidden", timeout: 240_000 });
    const failed =
      (await c.section("Run").locator('[data-status="failed"]').count()) > 0;
    if (failed) {
      const reason = await c.section("Run").getByRole("alert").innerText();
      c.problem(`The live ${model} model run failed. ${reason}`);
      await c.shot(
        "failure",
        `The live ${model} model run failed, and the app shows the reason. No output is claimed.`,
        c.section("Run")
      );
      return;
    }
    const call = c.calls.at(-1);
    const output = {
      latencyMs: call?.latencyMs,
      model: call?.model,
      source: "live",
    } as const;
    await c.shot(
      "candidates",
      `The live ${model} model run finished. The board shows what it drew, each candidate with its evaluation.`,
      c.section("Candidates"),
      true,
      output
    );
    if (await c.section("Run record").count()) {
      await c.shot(
        "record",
        "The run record names the live model, its latency and the prompt that was sent.",
        c.section("Run record"),
        false,
        output
      );
    }
  };
}
