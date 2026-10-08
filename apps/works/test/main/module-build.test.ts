import { InMemoryArtifactStore } from "@foundry/artifacts";
import { describe, expect, it, vi } from "vitest";
import { ModuleBuilds } from "~/main/modules/builds/controller";
import { createModuleLibrary } from "~/main/modules/library";
import { fakeClient, openFakeVault } from "../helpers/fake-api";
import { buildResult, successfulBuildRuntime } from "../helpers/module-build";

async function fixture() {
  const library = createModuleLibrary(new InMemoryArtifactStore());
  const module = await library.create("Editable starter");
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("Starter binding missing");
  }
  return { details, expected: details.binding, library, module };
}

describe("Module authoring and builds", () => {
  it("creates the shared runnable starter and rejects stale saves through the router", async () => {
    const { library, module, details, expected } = await fixture();
    expect(details.source["packages/app/src/App.tsx"]).toContain(
      "Editable starter"
    );
    expect(details.source["packages/server/src/index.ts"]).toBeDefined();
    expect(details.source["packages/module-sdk/package.json"]).toBeDefined();
    const source = { ...details.source, "packages/app/src/App.tsx": "edited" };
    const client = fakeClient(await openFakeVault(), library);
    const saved = await client.modules.saveSource({
      expected,
      id: module.id,
      source,
    });
    expect(saved).not.toEqual(expected);
    await expect(
      client.modules.saveSource({
        expected,
        id: module.id,
        source: details.source,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await library.details(module.id))?.source).toEqual(source);
  });

  it("publishes a build, revisions its saved source, and preserves the prior frozen release", async () => {
    const { library, module, details, expected } = await fixture();
    const builds = new ModuleBuilds(library, successfulBuildRuntime);
    const client = fakeClient(await openFakeVault(), library, { builds });
    const events = await Array.fromAsync(
      await client.modules.build({ expected, id: module.id, tag: "0.1.0" })
    );
    expect(events.at(-1)).toMatchObject({
      phase: "complete",
      release: { tag: "0.1.0" },
    });
    const built = await library.details(module.id);
    if (!(built?.binding && built.releases[0])) {
      throw new Error("Built release missing");
    }
    expect(built.source["bun.lock"]).toBeDefined();
    const saved = await library.saveSource(
      module.id,
      { ...built.source, "packages/app/src/App.tsx": "second edit" },
      built.binding
    );
    expect(saved.contentId).not.toBe(built.releases[0].contentId);
    expect(
      await library.release(module.id, built.releases[0].contentId)
    ).toMatchObject({ tag: "0.1.0" });
    await expect(
      library.publish(module.id, saved, {
        ...buildResult(details.source),
        tag: "0.1.0",
      })
    ).rejects.toThrow("already exists");
    await builds.shutdown();
  });

  it("does not publish failed or incomplete builds", async () => {
    const { library, module, expected, details } = await fixture();
    const builds = new ModuleBuilds(library, {
      async run() {
        throw new Error("Typecheck failed");
      },
      shutdown: vi.fn(async () => undefined),
    });
    const events = await Array.fromAsync(
      builds.watch(module.id, "0.1.0", expected)
    );
    expect(events.at(-1)).toEqual({
      message: "Typecheck failed",
      phase: "failed",
    });
    await expect(
      library.publish(module.id, expected, {
        outputs: {},
        source: details.source,
        tag: "0.1.0",
      })
    ).rejects.toThrow("absent");
    expect((await library.details(module.id))?.releases).toEqual([]);
    expect((await library.details(module.id))?.binding).toEqual(expected);
    await builds.shutdown();
  });

  it("fences publication against a source save made during compilation", async () => {
    const { library, module, expected, details } = await fixture();
    const builds = new ModuleBuilds(library, {
      async run(source) {
        await library.saveSource(
          module.id,
          { ...source, "README.md": "newer saved source" },
          expected
        );
        return buildResult(source);
      },
      shutdown: vi.fn(async () => undefined),
    });
    const events = await Array.fromAsync(
      builds.watch(module.id, "0.1.0", expected)
    );
    expect(events.at(-1)).toMatchObject({
      message: expect.stringContaining("changed during the build"),
      phase: "failed",
    });
    const saved = await library.details(module.id);
    expect(saved?.source["README.md"]).toBe("newer saved source");
    expect(saved?.source["packages/app/src/App.tsx"]).toBe(
      details.source["packages/app/src/App.tsx"]
    );
    expect(saved?.releases).toEqual([]);
    await builds.shutdown();
  });

  it("returns only after cancellation cleanup and rejects concurrent builds", async () => {
    const { library, module, expected } = await fixture();
    const cleaned = vi.fn();
    const entered = Promise.withResolvers<void>();
    const shutdown = vi.fn(async () => undefined);
    const builds = new ModuleBuilds(library, {
      async run(source, signal) {
        entered.resolve();
        try {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
          return buildResult(source);
        } finally {
          cleaned();
        }
      },
      shutdown,
    });
    const watch = builds.watch(module.id, "0.1.0", expected);
    await entered.promise;
    expect(() => builds.watch(module.id, "0.1.1", expected)).toThrow(
      "already running"
    );
    await watch.return();
    expect(cleaned).toHaveBeenCalledOnce();
    expect((await library.details(module.id))?.releases).toEqual([]);
    await builds.shutdown();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("drains active compilation on app shutdown without publishing", async () => {
    const { library, module, expected } = await fixture();
    const entered = Promise.withResolvers<void>();
    const stopped = vi.fn(async () => undefined);
    const builds = new ModuleBuilds(library, {
      async run(source, signal) {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
        return buildResult(source);
      },
      shutdown: stopped,
    });
    const stream = builds.watch(module.id, "0.1.0", expected);
    await entered.promise;
    await builds.shutdown();
    expect(stopped).toHaveBeenCalledOnce();
    expect((await Array.fromAsync(stream)).at(-1)).toMatchObject({
      phase: "failed",
    });
    expect((await library.details(module.id))?.releases).toEqual([]);
  });
});
