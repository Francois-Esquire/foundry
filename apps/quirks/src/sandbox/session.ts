import { createInMemoryAgentAuthorizer } from "@foundry/agents/authorization";
import type {
  AgentModel,
  HarnessPermissionProfile,
  HarnessSession,
} from "@foundry/agents/harness";
import { createDriverSession } from "@foundry/agents/harness";
import type { SessionStore } from "@foundry/agents/session";
import { createClaudeCodeDriver } from "@foundry/models/claude-code";
import { createCodexDriver } from "@foundry/models/codex";
import { prepareSandboxProcess } from "@foundry/sandbox/process";
import { sandboxContainer } from "~/lib/managers/sandboxes";
import type { SessionOptions } from "~/lib/types";
import { createBuiltinSession } from "./builtin-session";
import {
  claudeSubscriptionToken,
  codexSubscriptionTokens,
} from "./credentials";
import { prepareGuest } from "./prepare";
import { assertGuestSessionState } from "./session-state";

const SCHEDULED_PROFILE: HarnessPermissionProfile = {
  allowedTools: ["Read", "Glob", "Grep"],
  disallowedTools: [],
  maxSteps: 20,
  mode: "scheduled",
  unresolved: "deny",
};

const BUILTIN_SCHEDULED_PROFILE: HarnessPermissionProfile = {
  allowedTools: ["read", "glob", "grep"],
  disallowedTools: [],
  maxSteps: 30,
  mode: "scheduled",
  unresolved: "deny",
};

export interface SandboxSessionSettings {
  agentId: string;
  harness?: string;
  hostCwd?: string;
  instructions: string;
  model?: AgentModel;
  modelId: string;
  options: SessionOptions;
  provider: string;
  sessionId: string;
  signal: AbortSignal;
  store: SessionStore;
  write: (value: unknown) => void;
}

export async function createSandboxSession(
  settings: SandboxSessionSettings
): Promise<HarnessSession> {
  const { options } = settings;
  if (!options.sandbox) {
    throw new Error("A sandbox is required.");
  }

  const container = sandboxContainer(options.sandbox);
  const harness = settings.harness ?? settings.provider;
  const isCli = harness === "claude-code" || harness === "codex";
  const profile =
    options.profile ?? (isCli ? SCHEDULED_PROFILE : BUILTIN_SCHEDULED_PROFILE);
  if (harness !== "claude-code" && harness !== "codex") {
    return createBuiltinSession(settings, container, profile);
  }
  const { nativeId } = container.row;
  if (!nativeId) {
    throw new Error("Sandbox has no active guest instance.");
  }
  await assertGuestSessionState(
    settings.store,
    settings.sessionId,
    harness,
    nativeId
  );
  const chatgptAuthTokens =
    harness === "codex" && !options.apiKey
      ? await codexSubscriptionTokens()
      : undefined;
  const guest = await prepareGuest(container, {
    externalAuthentication: chatgptAuthTokens !== undefined,
    ...(harness === "claude-code" && !options.apiKey
      ? {
          oauthToken: await claudeSubscriptionToken({
            oauthToken: options.oauthToken,
          }),
        }
      : { apiKey: options.apiKey }),
    harness,
    sessionId: settings.sessionId,
    signal: settings.signal,
  });
  const driver =
    harness === "claude-code"
      ? createClaudeCodeDriver({
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
              container.processes.spawn([guest.executable, ...spawn.args], {
                cwd: "/workspace",
                environment: guest.environment,
                signal: spawn.signal
                  ? AbortSignal.any([settings.signal, spawn.signal])
                  : settings.signal,
              })
            ),
        })
      : createCodexDriver({
          agentId: settings.agentId,
          binPath: guest.executable,
          chatgptAuthTokens,
          cwd: "/workspace",
          env: guest.environment,
          instructions: settings.instructions,
          modelId: settings.modelId,
          refreshChatgptAuthTokens: chatgptAuthTokens
            ? () => codexSubscriptionTokens()
            : undefined,
          spawn: (argv, spawn) =>
            Promise.resolve(
              prepareSandboxProcess(() =>
                container.processes.spawn(argv, {
                  cwd: "/workspace",
                  environment: guest.environment,
                  signal: AbortSignal.any([settings.signal, spawn.signal]),
                })
              )
            ),
        });
  return createDriverSession(
    {
      agentId: settings.agentId,
      model: {
        harness,
        id: settings.modelId,
        provider: settings.provider,
      },
      policy:
        options.authority?.policy ??
        createInMemoryAgentAuthorizer({
          policy: { byKind: { "tool.call": "ask" }, global: "ask" },
        }).authorizer,
      profile,
      sessionId: settings.sessionId,
      store: settings.store,
      ...(options.authority?.approve
        ? { approve: options.authority.approve }
        : {}),
      onApprovalRequest: (request) => {
        settings.write({ request, type: "harness-approval" });
        options.authority?.onApprovalRequest?.(request);
      },
      onToolEvent: (event) => settings.write({ event, type: "harness-tool" }),
    },
    driver
  );
}
