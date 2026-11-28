import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeMcpClient } from "@foundry/agents/node";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import { Artifacts } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { stopOrphans } from "@foundry/lib/node/orphans";
import { createContainers } from "@foundry/sandbox/node";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createFakeDriver } from "@foundry/sandbox/testing";
import { workspaces } from "@foundry/workspaces/node";
import { type GitRun, git } from "@foundry/workspaces/node/git";
import { Catalog, type CollectInput } from "~/authoring/catalog";
import { declareCatalog } from "~/create";
import { Engine as DatabaseEngine } from "~/entries/engine";
import { commandRunner } from "~/host/command";
import { environmentSnapshot } from "~/host/environment";
import { readFeedMedia, resolveFeedMedia } from "~/host/feed-media";
import { guestAuth } from "~/host/guest/credentials";
import { FIRST_PARTY_DRIVERS } from "~/host/guest/drivers";
import { prepareGuest } from "~/host/guest/prepare";
import { NODE_OWNER_LIVENESS } from "~/host/liveness";
import { skillResolver } from "~/host/skills";
import { ensureWorktreeDir, nodeGitAt } from "~/host/workspaces";
import { Registry } from "~/lib/definitions/registry";
import type { EngineOptions } from "~/lib/engine";
import { Engine } from "~/lib/engine";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import type { TurnExecutorRef } from "~/lib/managers/cli-harnesses";
import { FileRunOutputSink } from "~/state/output";
import type { MockOptions, Reply } from "./echo";
import { CLAUDE_CODE, CODEX } from "./harnesses";
import { mockModels } from "./mock";

const NO_HOME = join(tmpdir(), "marbles-test-no-home");

export function echoGit(print: (line: string) => void): GitRun {
  return (cwd, args) => {
    print(`[git] ${cwd}: git ${args.join(" ")}`);
    return Promise.resolve("");
  };
}

export interface TestEngineOptions extends Partial<EngineOptions> {
  readonly catalog?: Catalog;
  readonly collect?: CollectInput;
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
            driver: createFakeDriver() as never,
            instanceLabel: "marbles-test",
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
    catalog: givenCatalog,
    collect,
    executors: _executors,
    hold: _hold,
    live: _live,
    reply: _reply,
    ...given
  } = options;
  const root = given.root ?? process.cwd();
  const workspaceId = given.workspaceId ?? "test";
  const home = given.home ?? NO_HOME;
  const instances = testInstances(options);
  const engineOptions: EngineOptions = {
    commandRunner,
    createMcpClient: createNodeMcpClient,
    ensureWorktreeDir,
    environment: environmentSnapshot(),
    gitAt: nodeGitAt(instances.git),
    home,
    liveness: NODE_OWNER_LIVENESS,
    ...(given.state === undefined
      ? {}
      : { outputSink: new FileRunOutputSink(given.state) }),
    readFeedMedia,
    resolveFeedMedia,
    root,
    sandboxGuest: {
      drivers: FIRST_PARTY_DRIVERS,
      guestAuth,
      prepareGuest,
    },
    skills: skillResolver({ home, workspace: root }),
    stopOrphans,
    workspaceId,
    worktrees: DatabaseEngine.worktreesFor(given.state),
    ...given,
    ...instances,
  };
  const { state } = engineOptions;
  const engine =
    state === undefined
      ? new Engine(engineOptions)
      : new DatabaseEngine({
          records: new MemoryWorkspaceRecords(),
          ...engineOptions,
        });
  const effective =
    givenCatalog ??
    (collect === undefined ? undefined : Catalog.collect(collect));
  if (effective !== undefined) {
    declareCatalog(engine, effective);
  }
  return engine;
}

export function startEngine(options: TestEngineOptions = {}): Promise<Engine> {
  return testEngine(options).start();
}

export function declared(input: Catalog | CollectInput): Registry {
  const registry = new Registry();
  declareCatalog(
    registry,
    input instanceof Catalog ? input : Catalog.collect(input)
  );
  return registry;
}
