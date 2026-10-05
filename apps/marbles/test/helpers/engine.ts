import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore } from "@foundry/agents/session";
import { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
import type { TurnExecutorRef } from "@foundry/models";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";
import { catalog } from "~/authoring/catalog";
import { declareCatalog, echoGit } from "~/create";
import type { EngineOptions } from "~/lib/engine";
import { Engine } from "~/lib/engine";
import { CLAUDE_CODE, CODEX } from "~/lib/harnesses";
import type { MockOptions, Reply } from "~/lib/models/echo";
import { mockModels } from "~/lib/models/echo";

/** A home with nothing in it, so no test reads the developer's own skills. */
const NO_HOME = join(tmpdir(), "marbles-test-no-home");

export interface TestEngineOptions extends Partial<EngineOptions> {
  /** Executors the mock models answer for; the first is the default. */
  readonly executors?: readonly TurnExecutorRef[];
  /** Turns to hold open until their signal fires; see `MockOptions`. */
  readonly hold?: MockOptions["hold"];
  /** Run git for real; the default echoes every mutation. */
  readonly live?: boolean;
  /** What a mock model answers; the prompt itself by default. */
  readonly reply?: Reply;
}

/** The instances a test engine is built from when the test names none. */
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
      options.artifacts ??
      new ArtifactSystem({ store: new InMemoryArtifactStore() }),
    containers:
      options.containers ??
      (() =>
        Promise.resolve(
          createContainers({
            allowedMountRoots: [root],
            instanceLabel: "marbles-test",
            runtime: createFakeContainerRuntime() as never,
            store: createMemoryContainerStore(),
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
    sessions: options.sessions ?? new InMemorySessionStore(),
    workspaces:
      options.workspaces ??
      new WorkspaceSystem().extend(
        directory({ observer: nodeObserver }),
        git(gitOptions)
      ),
  };
}

/**
 * An engine over mock models, in-memory stores, a real workspace system
 * with echoed git, and a fake container runtime, with everything the
 * authoring catalog holds declared to it. Any option replaces its default.
 */
export function testEngine(options: TestEngineOptions = {}): Engine {
  const {
    executors: _executors,
    hold: _hold,
    live: _live,
    reply: _reply,
    ...given
  } = options;
  const engine = new Engine({
    home: NO_HOME,
    root: process.cwd(),
    workspaceId: "test",
    ...given,
    ...testInstances(options),
  });
  declareCatalog(engine, catalog);
  return engine;
}

/** A started `testEngine`. */
export function startEngine(options: TestEngineOptions = {}): Promise<Engine> {
  return testEngine(options).start();
}
