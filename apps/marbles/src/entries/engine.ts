import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeMcpClient } from "@foundry/agents/node";
import { stopOrphans } from "@foundry/lib/node/orphans";
import { withWorkspaceDatabase } from "~/database/managed";
import { installNodeContextRuntime } from "~/lib/async-context/node";
import { commandRunner } from "~/lib/command";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";
import { environmentSnapshot } from "~/lib/environment";
import { inTurn } from "~/lib/in-turn";
import { skillResolver } from "~/lib/managers/skills";
import { localWorkspaces } from "~/lib/managers/workspaces";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
import { guestAuth } from "~/lib/sandbox/credentials";
import { FIRST_PARTY_DRIVERS } from "~/lib/sandbox/drivers";
import { prepareGuest } from "~/lib/sandbox/prepare";
import { FileRunOutputSink } from "~/lib/state/output";

installNodeContextRuntime();

export class Engine extends LibEngine {
  readonly #release: () => Promise<void>;
  #disposing: Promise<void> | undefined;

  static override worktreesFor(state: string | undefined): string {
    return join(state ?? join(tmpdir(), "marbles"), "worktrees");
  }

  constructor(options: EngineOptions) {
    const { state } = LibEngine.persistence(options);
    const home = options.home ?? homedir();
    const outputSink =
      options.outputSink ??
      (state === undefined ? undefined : new FileRunOutputSink(state));
    const withHostDefaults: EngineOptions = {
      ...options,
      commandRunner: options.commandRunner ?? commandRunner,
      createMcpClient: options.createMcpClient ?? createNodeMcpClient,
      environment: options.environment ?? environmentSnapshot(),
      liveness: options.liveness ?? NODE_OWNER_LIVENESS,
      ...(outputSink === undefined ? {} : { outputSink }),
      readFeedMedia: options.readFeedMedia ?? ((path) => readFile(path)),
      sandboxGuest: options.sandboxGuest ?? {
        drivers: FIRST_PARTY_DRIVERS,
        guestAuth,
        prepareGuest,
      },
      skills:
        options.skills ?? skillResolver({ home, workspace: options.root }),
      stopOrphans: options.stopOrphans ?? stopOrphans,
      workspaces: options.workspaces ?? localWorkspaces(options.git ?? {}),
      worktrees: options.worktrees ?? Engine.worktreesFor(state),
    };
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
