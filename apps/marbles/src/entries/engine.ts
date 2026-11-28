import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeMcpClient } from "@foundry/agents/node";
import { stopOrphans } from "@foundry/lib/node/orphans";
import { withWorkspaceDatabase } from "~/database/managed";
import { readFeedMedia, resolveFeedMedia } from "~/host/feed-media";
import {
  ensureWorktreeDir,
  localWorkspaces,
  nodeGitAt,
} from "~/host/workspaces";
import { installNodeContextRuntime } from "~/lib/async-context/node";
import { commandRunner } from "~/lib/command";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";
import { environmentSnapshot } from "~/lib/environment";
import { inTurn } from "~/lib/in-turn";
import { skillResolver } from "~/lib/managers/skills";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
import { guestAuth } from "~/lib/sandbox/credentials";
import { FIRST_PARTY_DRIVERS } from "~/lib/sandbox/drivers";
import { prepareGuest } from "~/lib/sandbox/prepare";
import { FileRunOutputSink } from "~/lib/state/output";

installNodeContextRuntime();

function withNodeDefaults(
  options: EngineOptions,
  state: string | undefined
): EngineOptions {
  const home = options.home ?? homedir();
  const outputSink =
    options.outputSink ??
    (state === undefined ? undefined : new FileRunOutputSink(state));
  return {
    commandRunner,
    createMcpClient: createNodeMcpClient,
    ensureWorktreeDir,
    environment: environmentSnapshot(),
    gitAt: nodeGitAt(options.git),
    liveness: NODE_OWNER_LIVENESS,
    readFeedMedia,
    resolveFeedMedia,
    sandboxGuest: {
      drivers: FIRST_PARTY_DRIVERS,
      guestAuth,
      prepareGuest,
    },
    skills: skillResolver({ home, workspace: options.root }),
    stopOrphans,
    workspaces: localWorkspaces(options.git ?? {}),
    worktrees: Engine.worktreesFor(state),
    ...options,
    ...(outputSink === undefined ? {} : { outputSink }),
  };
}

export class Engine extends LibEngine {
  readonly #release: () => Promise<void>;
  #disposing: Promise<void> | undefined;

  static override worktreesFor(state: string | undefined): string {
    return join(state ?? join(tmpdir(), "marbles"), "worktrees");
  }

  constructor(options: EngineOptions) {
    const { state } = LibEngine.persistence(options);
    const withHostDefaults = withNodeDefaults(options, state);
    const kept =
      state === undefined
        ? undefined
        : withWorkspaceDatabase({ ...withHostDefaults, state });
    super(kept?.options ?? withHostDefaults);
    this.#release = kept?.release ?? (() => Promise.resolve());
  }

  override dispose(): Promise<void> {
    this.#disposing ??= this.#dispose();
    return this.#disposing;
  }

  #dispose(): Promise<void> {
    return inTurn(
      () => super.dispose(),
      () => this.#release(),
      "Failed to dispose the engine and give up its database"
    );
  }
}
