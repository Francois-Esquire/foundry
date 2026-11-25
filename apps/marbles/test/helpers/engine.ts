import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import { Artifacts } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { createContainers } from "@foundry/sandbox/node";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { workspaces } from "@foundry/workspaces/node";
import { git } from "@foundry/workspaces/node/git";
import { catalog } from "~/authoring/catalog";
import { declareCatalog, echoGit } from "~/create";
import { Engine as DatabaseEngine } from "~/entries/engine";
import type { TurnExecutorRef } from "~/lib/cli-harnesses";
import type { EngineOptions } from "~/lib/engine";
import { Engine } from "~/lib/engine";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import { CLAUDE_CODE, CODEX } from "~/lib/harnesses";
import type { MockOptions, Reply } from "~/lib/models/echo";
import { mockModels } from "~/lib/models/mock";
import { Registry } from "~/lib/registry";

const NO_HOME = join(tmpdir(), "marbles-test-no-home");

export interface TestEngineOptions extends Partial<EngineOptions> {
  readonly executors?: readonly TurnExecutorRef[];
  readonly hold?: MockOptions["hold"];
  readonly live?: boolean;
  readonly reply?: Reply;
}

export function testInstances(
  options: TestEngineOptions = {}
): Pick<
  EngineOptions,
  "artifacts" | "containers" | "git" | "models" | "sessions" | "workspaces"
> {
  const root = options.root ?? process.cwd();
  const gitOptions =
    options.git ?? (options.live ? {} : { run: echoGit(() => undefined) });
  return {
    artifacts:
      options.artifacts ?? new Artifacts({ store: new MemoryArtifactStore() }),
    containers:
      options.containers ??
      (() =>
        Promise.resolve(
          createContainers({
            allowedMountRoots: [root],
            instanceLabel: "marbles-test",
            runtime: createFakeContainerRuntime() as never,
            store: new MemoryContainerStore(),
          })
        )),
    git: gitOptions,
    models:
      options.models ??
      mockModels(
        options.executors ?? [CLAUDE_CODE, CODEX],
        options.reply ?? (({ prompt }) => prompt),
        options.hold === undefined ? {} : { hold: options.hold }
      ),
    sessions: options.sessions ?? new MemorySessionStore(),
    workspaces: options.workspaces ?? workspaces().extend(git(gitOptions)),
  };
}

export function testEngine(options: TestEngineOptions = {}): Engine {
  const {
    executors: _executors,
    hold: _hold,
    live: _live,
    reply: _reply,
    ...given
  } = options;
  const root = given.root ?? process.cwd();
  const workspaceId = given.workspaceId ?? "test";
  const engineOptions: EngineOptions = {
    home: NO_HOME,
    root,
    workspaceId,
    ...given,
    ...testInstances(options),
  };
  const { state } = engineOptions;
  const engine =
    state === undefined
      ? new Engine(engineOptions)
      : new DatabaseEngine({
          records: new MemoryWorkspaceRecords(),
          ...engineOptions,
        });
  declareCatalog(engine, catalog);
  return engine;
}

export function startEngine(options: TestEngineOptions = {}): Promise<Engine> {
  return testEngine(options).start();
}

export function declared(): Registry {
  const registry = new Registry();
  declareCatalog(registry, catalog);
  return registry;
}
