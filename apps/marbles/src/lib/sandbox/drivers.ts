import type { HarnessTurnDriver } from "@foundry/agents/harness";
import {
  DEFAULT_SANDBOX_WORKING_DIRECTORY,
  SandboxError,
} from "@foundry/sandbox";
import { prepareSandboxProcess } from "@foundry/sandbox/node";
import type { CliHarness, GuestAuth } from "~/lib/cli-harnesses";
import { codexSubscriptionTokens } from "./credentials";
import type { PreparedGuest } from "./prepare";
import type { SandboxSessionSettings } from "./session";

function requireSpawn(settings: SandboxSessionSettings) {
  const spawn = settings.container.processes?.spawn;
  if (spawn === undefined) {
    throw new SandboxError(
      "unsupported",
      "CLI harness requires a sandbox driver that supports piped process spawning"
    );
  }
  return spawn;
}

interface GuestDriverInput {
  readonly auth: GuestAuth;
  readonly guest: PreparedGuest;
  readonly settings: SandboxSessionSettings;
}

export type GuestDriver = (
  input: GuestDriverInput
) => HarnessTurnDriver | Promise<HarnessTurnDriver>;

export const FIRST_PARTY_DRIVERS: Readonly<Record<CliHarness, GuestDriver>> = {
  "claude-code": async ({ guest, settings }) => {
    const spawnProcess = requireSpawn(settings);
    const { createClaudeCodeDriver } = await import(
      "@foundry/models/providers/claude-code"
    );
    return createClaudeCodeDriver({
      agentId: settings.agentId,
      cwd: settings.hostCwd,
      modelId: settings.modelId,
      settings: {
        env: { ...guest.environment },
        pathToClaudeCodeExecutable: guest.executable,
        systemPrompt: settings.instructions,
      },
      spawnClaudeCodeProcess: (spawn) =>
        prepareSandboxProcess(() =>
          spawnProcess([guest.executable, ...spawn.args], {
            cwd: DEFAULT_SANDBOX_WORKING_DIRECTORY,
            environment: guest.environment,
            signal: spawn.signal
              ? AbortSignal.any([settings.signal, spawn.signal])
              : settings.signal,
          })
        ),
    });
  },
  codex: async ({ auth, guest, settings }) => {
    const spawnProcess = requireSpawn(settings);
    const { createCodexDriver } = await import(
      "@foundry/models/providers/codex"
    );
    return createCodexDriver({
      agentId: settings.agentId,
      binPath: guest.executable,
      cwd: DEFAULT_SANDBOX_WORKING_DIRECTORY,
      env: guest.environment,
      instructions: settings.instructions,
      modelId: settings.modelId,
      ...(auth.kind === "chatgpt"
        ? {
            chatgptAuthTokens: auth.tokens,
            refreshChatgptAuthTokens: () =>
              codexSubscriptionTokens(settings.execution?.env),
          }
        : {}),
      spawn: (argv, spawn) =>
        Promise.resolve(
          prepareSandboxProcess(() =>
            spawnProcess(argv, {
              cwd: DEFAULT_SANDBOX_WORKING_DIRECTORY,
              environment: guest.environment,
              signal: AbortSignal.any([settings.signal, spawn.signal]),
            })
          )
        ),
    });
  },
  pi: async ({ guest, settings }) => {
    const spawnProcess = requireSpawn(settings);
    const { createPiDriver } = await import("@foundry/models/providers/pi");
    return createPiDriver({
      agentId: settings.agentId,
      binPath: guest.executable,
      cwd: DEFAULT_SANDBOX_WORKING_DIRECTORY,
      env: guest.environment,
      instructions: settings.instructions,
      modelId: settings.modelId,
      sessionDirectory: `${guest.environment.PI_CODING_AGENT_DIR}/sessions`,
      spawn: async (argv, spawn) =>
        prepareSandboxProcess(() =>
          spawnProcess(argv, {
            cwd: DEFAULT_SANDBOX_WORKING_DIRECTORY,
            environment: guest.environment,
            signal: AbortSignal.any([settings.signal, spawn.signal]),
          })
        ),
      async writeExtension(source) {
        const path = `${guest.environment.PI_CODING_AGENT_DIR}/foundry-tools.mjs`;
        await settings.container.files.copyIn({
          [path]: new TextEncoder().encode(source),
        });
        return path;
      },
    });
  },
};
