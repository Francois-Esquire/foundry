import type { HarnessTurnDriver } from "@foundry/agents/harness";
import { createClaudeCodeDriver } from "@foundry/models/claude-code";
import { createCodexDriver } from "@foundry/models/codex";
import { createPiDriver } from "@foundry/models/pi";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox/constants";
import { prepareSandboxProcess } from "@foundry/sandbox/process";
import type { CliHarness, GuestAuth } from "~/lib/cli-harnesses";
import { codexSubscriptionTokens } from "./credentials";
import type { PreparedGuest } from "./prepare";
import type { SandboxSessionSettings } from "./session";

interface GuestDriverInput {
  readonly auth: GuestAuth;
  readonly guest: PreparedGuest;
  readonly settings: SandboxSessionSettings;
}

/** Drives a CLI prepared in the guest from the host, spawning it in the sandbox. */
export type GuestDriver = (input: GuestDriverInput) => HarnessTurnDriver;

/** The first-party driver for each CLI harness. */
export const FIRST_PARTY_DRIVERS: Readonly<Record<CliHarness, GuestDriver>> = {
  "claude-code": ({ guest, settings }) =>
    createClaudeCodeDriver({
      agentId: settings.agentId,
      cwd: settings.hostCwd ?? process.cwd(),
      modelId: settings.modelId,
      settings: {
        env: { ...guest.environment },
        pathToClaudeCodeExecutable: guest.executable,
        systemPrompt: settings.instructions,
      },
      spawnClaudeCodeProcess: (spawn) =>
        prepareSandboxProcess(() =>
          settings.container.processes.spawn(
            [guest.executable, ...spawn.args],
            {
              cwd: DEFAULT_SANDBOX_WORKING_DIRECTORY,
              environment: guest.environment,
              signal: spawn.signal
                ? AbortSignal.any([settings.signal, spawn.signal])
                : settings.signal,
            }
          )
        ),
    }),
  codex: ({ auth, guest, settings }) =>
    createCodexDriver({
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
            settings.container.processes.spawn(argv, {
              cwd: DEFAULT_SANDBOX_WORKING_DIRECTORY,
              environment: guest.environment,
              signal: AbortSignal.any([settings.signal, spawn.signal]),
            })
          )
        ),
    }),
  pi: ({ guest, settings }) =>
    createPiDriver({
      agentId: settings.agentId,
      binPath: guest.executable,
      cwd: DEFAULT_SANDBOX_WORKING_DIRECTORY,
      env: guest.environment,
      instructions: settings.instructions,
      modelId: settings.modelId,
      sessionDirectory: `${guest.environment.PI_CODING_AGENT_DIR}/sessions`,
      spawn: async (argv, spawn) =>
        prepareSandboxProcess(() =>
          settings.container.processes.spawn(argv, {
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
    }),
};
