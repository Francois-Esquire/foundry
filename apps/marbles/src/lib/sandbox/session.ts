import type { ObserveTurn } from "@foundry/agents/agents";
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
import type { SessionStore } from "@foundry/agents/store";
import type { Container } from "@foundry/sandbox";
import type { Tool, ToolSet } from "ai";
import { type CliHarness, isCliHarness } from "~/lib/cli-harnesses";
import type { RecordObservation } from "~/lib/observations";
import type { Execution } from "~/lib/providers/plugins";
import type { SandboxAgentOptions } from "~/lib/types";
import { resolveCompaction } from "../managers/session-options";
import { createCodingTools } from "./coding-tools";
import { guestAuth } from "./credentials";
import { type DelegationScope, delegationTool } from "./delegate";
import { FIRST_PARTY_DRIVERS } from "./drivers";
import { prepareGuest } from "./prepare";
import { assertGuestSessionState } from "./session-state";
import { observedSession } from "./wrapped-session";

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

export type SandboxAuthority = Pick<
  HarnessAuthoritySettings,
  "approve" | "onApprovalRequest" | "policy"
>;

export interface SandboxSessionOptions extends SandboxAgentOptions {
  readonly authority: SandboxAuthority;
}

export interface SandboxSessionSettings {
  agentId: string;
  container: Container;
  delegation?: DelegationScope;
  execution?: Execution;
  harness: string;
  hostCwd: string;
  hostToolsForSession?: (sessionId: string) => ToolSet;
  instructions: string;
  model?: AgentModel;
  modelId: string;
  observe?: ObserveTurn;
  onActivity?: (event: HarnessActivityEvent) => void | Promise<void>;
  onChildSession?: (
    sessionId: string,
    session: HarnessSession
  ) => HarnessSession;
  options: SandboxSessionOptions;
  parentActivityId?: string;
  provider: string;
  record?: RecordObservation;
  registerChildSession?: (sessionId: string) => Promise<void>;
  sessionId: string;
  signal: AbortSignal;
  store: SessionStore;
  wireModelId?: string;
  write: (value: unknown) => void;
}

interface SessionShared {
  readonly approvals: Pick<SandboxAuthority, "approve" | "onApprovalRequest">;
  readonly askUser: Tool;
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
    const session = await cliSession(settings, harness, shared);
    return settings.record
      ? observedSession(session, settings.record, { tools: false, turns: true })
      : session;
  }
  return builtinSession(settings, shared);
}

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
      compaction: resolveCompaction(options.compaction ?? true, model),
      instructions: settings.instructions,
      maxSteps: profile.maxSteps,
      model,
      ...(settings.observe ? { observe: settings.observe } : {}),
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

async function cliSession(
  settings: SandboxSessionSettings,
  harness: CliHarness,
  { approvals, askUser, hostTools }: SessionShared
): Promise<HarnessSession> {
  const { container, execution, options } = settings;
  if (options.compaction !== undefined) {
    throw new Error(
      "Native CLI sessions manage their own compaction; compaction settings require a network model."
    );
  }
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
  const modelId = settings.wireModelId ?? settings.modelId;
  const auth = await guestAuth(harness, {
    ...options,
    ...(execution ? { env: execution.env } : {}),
    ...(execution?.bin ? { bin: execution.bin } : {}),
    modelId,
  });
  const guest = await prepareGuest(container, {
    auth,
    harness,
    sessionId: settings.sessionId,
    signal: settings.signal,
  });
  const driver = await (execution?.driver ?? FIRST_PARTY_DRIVERS[harness])({
    auth,
    guest,
    settings: { ...settings, modelId },
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
      tools: {
        ...hostTools,
        ...(harness === "pi" ? createCodingTools(container) : {}),
        ask_user: askUser,
      },
    },
    driver
  );
}
