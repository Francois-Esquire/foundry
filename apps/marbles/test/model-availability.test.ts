import { expect, it } from "vitest";
import { agent, models } from "~/authoring";
import { libraryOfLoad } from "~/authoring/bound";
import { Catalog } from "~/authoring/catalog";
import { loadInto, releaseEngine, setHost } from "~/authoring/runtime";
import { testEngine } from "./helpers/engine";

it("checks the engine bound to the importing load, including after a replacement", async () => {
  const workspaceId = "model-availability";
  const first = new Catalog();
  const second = new Catalog();
  const original = testEngine({
    executors: [{ harness: "codex", model: "first-only", provider: "codex" }],
    workspaceId,
  });
  const replacement = testEngine({
    executors: [{ harness: "codex", model: "second-only", provider: "codex" }],
    workspaceId,
  });
  const bind = (into: Catalog) =>
    loadInto(workspaceId, into, (load) =>
      Promise.resolve(libraryOfLoad({ models }, load).models as typeof models)
    );

  try {
    const prior = await bind(first);
    expect(prior.available("codex/first-only")).toBe(false);
    setHost(original, first);
    const later = await bind(second);
    setHost(replacement, second);

    expect(prior.available("codex/first-only")).toBe(true);
    expect(prior.available("second-only")).toBe(false);
    expect(later.available("codex/second-only")).toBe(true);
    expect(later.available("first-only")).toBe(false);
    await original.dispose();
    releaseEngine(original);
    expect(() => prior.available("codex/first-only")).toThrow(
      "no longer hosted"
    );
  } finally {
    await Promise.all([original.dispose(), replacement.dispose()]);
    releaseEngine(original);
    releaseEngine(replacement);
  }
});

it("checks the engine opening an embedded session inside deferred agent configuration", async () => {
  const engine = testEngine({
    executors: [
      { harness: "codex", model: "embedded-only", provider: "codex" },
    ],
    workspaceId: "model-availability-embedded",
  });
  const recipe = agent(async () => {
    await Promise.resolve();
    expect(models.available("codex/embedded-only")).toBe(true);
    expect(models.available("codex/missing")).toBe(false);
    return { model: "embedded-only", prompt: "Review.", provider: "codex" };
  });

  try {
    const session = await engine.agents.session(recipe);
    expect(session.ref.model).toBe("embedded-only");
  } finally {
    await engine.dispose();
  }
});
