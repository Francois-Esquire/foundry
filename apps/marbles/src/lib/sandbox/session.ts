import type {
  AgentModel,
  HarnessActivityEvent,
  HarnessAuthoritySettings,
  HarnessPermissionProfile,
  HarnessSession,
  HarnessTurnDriver,
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
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox/constants";
import type { Container } from "@foundry/sandbox/container/containers";
import { prepareSandboxProcess } from "@foundry/sandbox/process";
import type { Tool, ToolSet } from "ai";
import {
  type CliHarness,
  type GuestAuth,
  isCliHarness,
} from "~/lib/cli-harnesses";
import type { SessionOptions } from "~/lib/types";
import { createCodingTools } from "./coding-tools";
import { codexSubscriptionTokens, guestAuth } from "./credentials";
import { type DelegationScope, delegationTool } from "./delegate";
import { type PreparedGuest, prepareGuest } from "./prepare";
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

/**
 * Who decides what a sandboxed agent may do, and who hears about it. A host
 * builds one with `HarnessInteractions.authority`.
 */
export type SandboxAuthority = Pick<
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
  /** A CLI harness runs its CLI in the guest; any other runs the built-in coding harness. */
  harness: string;
  hostCwd?: string;
  /** Host tools for one session; a delegated child gets its own. */
  hostToolsForSession?: (sessionId: string) => ToolSet;
  instructions: string;
  model?: AgentModel;
  modelId: string;
  onActivity?: (event: HarnessActivityEvent) => void | Promise<void>;
  /** Track a delegated child; the delegate drives and closes the session this returns. */
  onChildSession?: (
    sessionId: string,
    session: HarnessSession
  ) => HarnessSession;
  options: SandboxSessionOptions;
  parentActivityId?: string;
  provider: string;
  registerChildSession?: (sessionId: string) => Promise<void>;
  sessionId: string;
  signal: AbortSignal;
  store: SessionStore;
  write: (value: unknown) => void;
}

/** What both kinds of harness are handed alike: approvals, `ask_user`, and the host's tools. */
interface SessionShared {
  readonly approvals: Pick<SandboxAuthority, "approve" | "onApprovalRequest">;
  readonly askUser: Tool;
  /** This session's host tools and `delegate`. */
  readonly hostTools: ToolSet;
}

export async function createSandboxSession(
  settings: SandboxSessionSettings
): Promise<HarnessSession> {
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
    hostTools: {
      ...settings.hostToolsForSession?.(settings.sessionId),
      delegate: delegationTool(settings, createSandboxSession),
    },
  };
  if (isCliHarness(harness)) {
    return await cliSession(settings, harness, shared);
  }
  return builtinSession(settings, shared);
}

/** The built-in coding harness on a network model, its tools working in the guest. */
function builtinSession(
  settings: SandboxSessionSettings,
  { approvals, askUser, hostTools }: SessionShared
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
        ...hostTools,
        ...createCodingTools(container),
        ask_user: askUser,
      },
    },
    { sessionId: settings.sessionId }
  );
}

/** What a CLI harness's driver is built from, once its guest is ready. */
interface DriverInput<H extends CliHarness> {
  readonly auth: GuestAuth<H>;
  readonly guest: PreparedGuest;
  readonly settings: SandboxSessionSettings;
}

/** Each CLI harness's host driver, spawning its CLI in the guest. */
const DRIVERS: {
  readonly [H in CliHarness]: (input: DriverInput<H>) => HarnessTurnDriver;
} = {
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
            refreshChatgptAuthTokens: () => codexSubscriptionTokens(),
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
};

/** A native CLI harness prepared in the guest, driven from the host. */
async function cliSession<H extends CliHarness>(
  settings: SandboxSessionSettings,
  harness: H,
  { approvals, askUser, hostTools }: SessionShared
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
  const auth = await guestAuth(harness, options);
  const guest = await prepareGuest(container, {
    auth,
    harness,
    sessionId: settings.sessionId,
    signal: settings.signal,
  });
  const driver = DRIVERS[harness]({ auth, guest, settings });
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
      tools: { ...hostTools, ask_user: askUser },
    },
    driver
  );
}
