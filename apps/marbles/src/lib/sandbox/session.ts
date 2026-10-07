import type {
  AgentModel,
  HarnessActivityEvent,
  HarnessAuthoritySettings,
  HarnessPermissionProfile,
  HarnessSession,
} from "@foundry/agents/harness";
import {
  createBuiltinCodingHarness,
  createDriverSession,
  createHarnessPermission,
  createHarnessQuestionTool,
} from "@foundry/agents/harness";
import type { SessionStore } from "@foundry/agents/session";
import { createModelSummarizer } from "@foundry/agents/session";
import { createClaudeCodeDriver } from "@foundry/models/claude-code";
import { createCodexDriver } from "@foundry/models/codex";
import type { Container } from "@foundry/sandbox/container/containers";
import { prepareSandboxProcess } from "@foundry/sandbox/process";
import type { Tool, ToolSet } from "ai";
import type { SessionOptions } from "~/lib/types";
import { createCodingTools } from "./coding-tools";
import {
  claudeSubscriptionToken,
  codexSubscriptionTokens,
} from "./credentials";
import { type DelegationScope, delegationTool } from "./delegate";
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

/** Who decides what a sandboxed agent may do, and who hears about it. */
type SandboxAuthority = Pick<
  HarnessAuthoritySettings,
  "approve" | "onApprovalRequest" | "policy"
>;

/** A session's options once the host has resolved its authority. */
export interface SandboxSessionOptions extends SessionOptions {
  readonly authority: SandboxAuthority;
}

export interface SandboxSessionSettings {
  agentId: string;
  /** The container behind `options.sandbox`; the harness runs inside it. */
  container: Container;
  delegation?: DelegationScope;
  /** `claude-code` or `codex` run their CLI in the guest; any other runs the built-in coding harness. */
  harness: string;
  hostCwd?: string;
  hostTools?: ToolSet;
  hostToolsForSession?: (sessionId: string) => ToolSet;
  instructions: string;
  model?: AgentModel;
  modelId: string;
  onActivity?: (event: HarnessActivityEvent) => void | Promise<void>;
  onChildSession?: (
    sessionId: string,
    activityId: string,
    session: HarnessSession
  ) => void;
  options: SandboxSessionOptions;
  parentActivityId?: string;
  provider: string;
  registerChildSession?: (sessionId: string) => Promise<void>;
  sessionId: string;
  signal: AbortSignal;
  store: SessionStore;
  write: (value: unknown) => void;
}

/** What both kinds of harness are handed alike: approvals and the `ask_user` tool. */
interface SessionShared {
  readonly approvals: Pick<SandboxAuthority, "approve" | "onApprovalRequest">;
  readonly askUser: Tool;
}

export async function createSandboxSession(
  input: SandboxSessionSettings
): Promise<HarnessSession> {
  const settings = {
    ...input,
    hostTools: {
      ...input.hostTools,
      ...input.hostToolsForSession?.(input.sessionId),
      delegate: delegationTool(input, createSandboxSession),
    },
  };
  const { harness, options } = settings;
  if (!options.sandbox) {
    throw new Error("A sandbox is required.");
  }
  const { authority } = options;
  const shared: SessionShared = {
    approvals: {
      ...(authority.approve ? { approve: authority.approve } : {}),
      async onApprovalRequest(request) {
        settings.write({ request, type: "harness-approval" });
        await authority.onApprovalRequest?.(request);
      },
    },
    askUser: createHarnessQuestionTool({
      question: options.question,
      sessionId: settings.sessionId,
    }),
  };
  if (harness === "claude-code" || harness === "codex") {
    return await cliSession(settings, harness, shared);
  }
  return builtinSession(settings, shared);
}

/** The built-in coding harness on a network model, its tools working in the guest. */
function builtinSession(
  settings: SandboxSessionSettings,
  { approvals, askUser }: SessionShared
): HarnessSession {
  const { container, model, options } = settings;
  if (!model) {
    throw new Error(
      "A registered network model is required for built-in coding."
    );
  }
  const profile = options.profile ?? BUILTIN_SCHEDULED_PROFILE;
  const { policy } = options.authority;
  const permission = createHarnessPermission({
    agentId: settings.agentId,
    policy,
    profile,
    store: settings.store,
    ...approvals,
  });
  return createBuiltinCodingHarness(
    {
      agentId: settings.agentId,
      compaction: {
        summarizer: createModelSummarizer({ model }),
        ...(typeof options.compaction === "object" ? options.compaction : {}),
      },
      instructions: settings.instructions,
      maxSteps: profile.maxSteps,
      model,
      permission: (request) =>
        permission({
          ...request,
          activityId: request.activityId ?? settings.parentActivityId,
        }),
      policy,
      sessionId: settings.sessionId,
      store: settings.store,
      tools: {
        ...settings.hostTools,
        ...createCodingTools(container, { workspacePath: "/workspace" }),
        ask_user: askUser,
      },
    },
    { sessionId: settings.sessionId }
  );
}

/** A native CLI harness prepared in the guest, driven from the host. */
async function cliSession(
  settings: SandboxSessionSettings,
  harness: "claude-code" | "codex",
  { approvals, askUser }: SessionShared
): Promise<HarnessSession> {
  const { container, options } = settings;
  const profile = options.profile ?? SCHEDULED_PROFILE;
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
      parentActivityId: settings.parentActivityId,
      policy: options.authority.policy,
      profile,
      sessionId: settings.sessionId,
      store: settings.store,
      ...approvals,
      onActivity: async (event) => {
        settings.write({ event, type: "harness-activity" });
        await settings.onActivity?.(event);
      },
      onToolEvent: (event) => settings.write({ event, type: "harness-tool" }),
      question: options.question,
      tools: { ...settings.hostTools, ask_user: askUser },
    },
    driver
  );
}
