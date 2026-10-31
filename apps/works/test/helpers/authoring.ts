import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryArtifactStore } from "@foundry/artifacts";
import { onTestFinished } from "vitest";
import type { WorksExecution } from "~/main/execution/contract";
import type { AuthoringTurnRunner } from "~/main/modules/authoring/agent";
import {
  type AuthoringModels,
  ModuleAuthoring,
  type ModuleAuthoringOptions,
} from "~/main/modules/authoring/service";
import {
  createModuleLibrary,
  type ModuleLibrary,
} from "~/main/modules/library";
import { fakeModuleSandboxes } from "./module-sandboxes";
import { unrecordedSaves } from "./source-saves";

const scriptedRoute: AuthoringModels = {
  route: () => ({ model: "scripted/coder", provider: "scripted" }),
};

async function authoringDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "works-authoring-"));
  onTestFinished(() =>
    rm(directory, { force: true, maxRetries: 5, recursive: true })
  );
  return directory;
}

/**
 * A Module in an in-memory library and the authoring service over the
 * in-memory sandbox runtime. The execution and runner decide how real the
 * turn is: the engine and a scripted model, or inline and scripted guest
 * edits.
 */
export async function authoringFixture(options: {
  directory?: string;
  execution: Pick<WorksExecution, "launch">;
  library?: ModuleLibrary;
  models?: AuthoringModels;
  runner?: AuthoringTurnRunner;
  service?: Partial<ModuleAuthoringOptions>;
}) {
  const library =
    options.library ??
    createModuleLibrary(new InMemoryArtifactStore(), {
      saves: unrecordedSaves,
    });
  const module = await library.create("Chat test");
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("Starter binding missing");
  }
  const { runtime, sandboxes } = fakeModuleSandboxes();
  const directory = options.directory ?? (await authoringDirectory());
  const open = () =>
    new ModuleAuthoring({
      directory,
      execution: options.execution,
      library,
      models: options.models ?? scriptedRoute,
      sandboxes,
      ...(options.runner ? { runner: options.runner } : {}),
      ...options.service,
    });
  return {
    binding: details.binding,
    details,
    directory,
    library,
    module,
    open,
    runtime,
    sandboxes,
    service: open(),
  };
}
