import { InMemoryArtifactStore } from "@foundry/artifacts";
import type { ModuleVersion } from "@foundry/modules/domain";
import { expect, it, vi } from "vitest";
import { ModuleBuilds } from "~/main/modules/builds/controller";
import { createModuleLibrary } from "~/main/modules/library";
import { openModuleApp } from "~/main/modules/open-app";
import { ModuleSessions } from "~/main/modules/runtime/controller";
import { successfulBuildRuntime } from "../helpers/module-build";

it("builds on first open, opens the latest release next time, and closes each app VM", async () => {
  const library = createModuleLibrary(new InMemoryArtifactStore());
  const module = await library.create("App first");
  const run = vi.fn(successfulBuildRuntime.run);
  const builds = new ModuleBuilds(library, { ...successfulBuildRuntime, run });
  const close = vi.fn(async () => undefined);
  const start = vi.fn(async (_version: ModuleVersion) => ({
    close,
    origin: "http://127.0.0.1:3000",
  }));
  const sessions = new ModuleSessions(library, {
    shutdown: vi.fn(async () => undefined),
    start,
  });
  const opened = openModuleApp(library, builds, sessions, module.id);
  let state = await opened.next();
  while (!state.done && state.value.phase !== "ready") {
    state = await opened.next();
  }
  expect(state.value).toMatchObject({ phase: "ready" });
  await opened.return();
  expect(close).toHaveBeenCalledOnce();
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("Source missing");
  }
  await Array.fromAsync(builds.watch(module.id, "0.1.1", details.binding));
  const reopened = openModuleApp(library, builds, sessions, module.id);
  expect((await reopened.next()).value).toEqual({ phase: "starting" });
  expect((await reopened.next()).value).toMatchObject({ phase: "ready" });
  expect(start.mock.calls.at(-1)?.[0]).toMatchObject({ tag: "0.1.1" });
  expect(run).toHaveBeenCalledTimes(2);
  await reopened.return();
  await builds.shutdown();
  await sessions.shutdown();
  expect(close).toHaveBeenCalledTimes(2);
});
