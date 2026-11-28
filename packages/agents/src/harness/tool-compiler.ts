import type {
  AccessRequest,
  Authorization,
  Permit,
} from "@foundry/authorization";
import type { HarnessPermissionCallback } from "@foundry/core/agents";
import type {
  ModelMessage,
  TextStreamPart,
  Tool,
  ToolExecutionOptions,
  ToolSet,
  TypedToolCall,
} from "ai";
import { z } from "zod";
import {
  agentPrincipal,
  agentPrincipalMatcher,
  capabilityToAccessRequest,
  capabilityToScope,
  HOST_APPROVER,
} from "../authorization/authorization";
import type { Capability, ToolSource } from "../authorization/capability";
import { isHarnessQuestionTool } from "./question";
import type { StreamPart } from "./stream-transform";
import { keepToolOutput } from "./tool-output";
import type {
  AgentIdentity,
  AgentInvocationContext,
  HarnessToolRegistration,
  RegisteredToolCall,
  ToolEffectLocation,
} from "./tool-registration";
import { registrationsOf } from "./tool-registration";

export interface ToolCompilerDeps extends AgentIdentity {
  authoritySessionId?: string;
  authorization: Authorization;
  permission?: HarnessPermissionCallback;
}

type ToolCallContext = Omit<AgentInvocationContext, keyof AgentIdentity>;

export interface CompiledTools {
  registrationFor: (
    toolName: string,
    input: unknown,
    call: ToolCallContext
  ) => RegisteredToolCall | undefined;
  tools: ToolSet;
}

interface PolicyDeniedOutput {
  approved: false;
  reason: string;
}

const policyDenials = new WeakSet<object>();

export function isPolicyDeniedOutput(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && policyDenials.has(value)
  );
}

function deniedOutput(reason: string): PolicyDeniedOutput {
  const output: PolicyDeniedOutput = { approved: false, reason };
  policyDenials.add(output);
  return output;
}

export function deriveInvocationId(
  { agentId, sessionId }: AgentIdentity,
  toolCallId: string
): string {
  return `${agentId}:${sessionId}:${toolCallId}`;
}

export function registerToolCall<TInput>(
  args: Omit<RegisteredToolCall<TInput>, "invocationId">
): RegisteredToolCall<TInput> {
  return {
    ...args,
    invocationId: deriveInvocationId(args, args.toolCallId),
  };
}

function identityOf({
  agentGeneration,
  agentId,
  sessionId,
}: AgentIdentity): AgentIdentity {
  return { agentGeneration, agentId, sessionId };
}

function registrationEffectLocation(
  registration: HarnessToolRegistration
): ToolEffectLocation {
  return (
    registration.effectLocation ??
    (registration.tool.execute ? "runtime" : "host")
  );
}

function registeredCallFor<TInput>(
  registration: HarnessToolRegistration,
  input: TInput,
  deps: ToolCompilerDeps,
  call: ToolCallContext
): RegisteredToolCall<TInput> {
  const identity = identityOf(deps);
  return registerToolCall({
    ...identity,
    capability: registration.capability(input, { ...identity, ...call }),
    effectLocation: registrationEffectLocation(registration),
    input,
    source: registration.source,
    toolCallId: call.toolCallId,
    toolName: registration.name,
  });
}

export interface ToolAccessRequestArgs extends AgentIdentity {
  readonly authoritySessionId?: string;
  readonly capability: Capability;
  readonly input: unknown;
  readonly tool: { readonly name: string; readonly source: ToolSource };
  readonly toolCallId: string;
}

export function toolAccessRequest(args: ToolAccessRequestArgs): AccessRequest {
  return capabilityToAccessRequest({
    agentGeneration: args.agentGeneration,
    agentId: args.agentId,
    capability: args.capability,
    input: args.input,
    invocationId: deriveInvocationId(args, args.toolCallId),
    sessionId: args.authoritySessionId ?? args.sessionId,
  });
}

function requestFor(
  call: RegisteredToolCall,
  authoritySessionId?: string
): AccessRequest {
  return toolAccessRequest({
    ...call,
    ...(authoritySessionId === undefined ? {} : { authoritySessionId }),
    tool: { name: call.toolName, source: call.source },
  });
}

async function resolveOriginalNeedsApproval(
  needsApproval: Tool["needsApproval"],
  input: unknown,
  options: {
    toolCallId: string;
    messages: ModelMessage[];
    context: unknown;
  }
): Promise<boolean> {
  if (needsApproval === null || needsApproval === undefined) {
    return false;
  }
  if (typeof needsApproval === "boolean") {
    return needsApproval;
  }
  return await needsApproval(input, options);
}

function wasApprovalRequestedFor(
  toolCallId: string,
  messages: readonly ModelMessage[]
): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some(
      (part: { type?: string; toolCallId?: string }) =>
        part.type === "tool-approval-request" && part.toolCallId === toolCallId
    );
  });
}

function wasApprovalGrantedFor(
  toolCallId: string,
  messages: readonly ModelMessage[]
): boolean {
  const approvalIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (
        part.type === "tool-approval-request" &&
        part.toolCallId === toolCallId
      ) {
        approvalIds.add(part.approvalId);
      }
    }
  }
  if (approvalIds.size === 0) {
    return false;
  }
  return messages.some(
    (message) =>
      message.role === "tool" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          part.type === "tool-approval-response" &&
          part.approved &&
          approvalIds.has(part.approvalId)
      )
  );
}

type ToolAuthResult =
  | { readonly denied: PolicyDeniedOutput; readonly permit?: undefined }
  | { readonly denied?: undefined; readonly permit?: Permit };

interface ToolAuthorization {
  authorize(
    call: RegisteredToolCall,
    options: ToolExecutionOptions<unknown>
  ): Promise<ToolAuthResult>;
  requiresApproval(call: RegisteredToolCall): Promise<boolean>;
}

function standardAuthorization(
  authorization: Authorization,
  authoritySessionId?: string
): ToolAuthorization {
  return {
    async authorize(call, options) {
      const request = requestFor(call, authoritySessionId);
      const decision = await authorization.check(request);
      if (decision.kind === "deny") {
        return { denied: deniedOutput(decision.reason) };
      }
      if (decision.kind === "ask") {
        if (!wasApprovalGrantedFor(options.toolCallId, options.messages)) {
          return {
            denied: deniedOutput("Approval required but not yet resolved."),
          };
        }
        const pending = await authorization.request({
          holder: agentPrincipalMatcher(call.agentId, call.agentGeneration),
          invocationId: call.invocationId,
          requestedBy: agentPrincipal(call.agentId, call.agentGeneration),
          scope: capabilityToScope(call.capability),
          sessionId: authoritySessionId ?? call.sessionId,
          usesRemaining: 1,
        });
        await authorization.approve(pending.id, {
          approver: HOST_APPROVER,
          rootAuthority: true,
        });
      }

      const outcome = await authorization.authorize(
        request,
        call.invocationId,
        {
          openPending: false,
          ...(options.abortSignal === undefined
            ? {}
            : { signal: options.abortSignal }),
        }
      );
      if (outcome.kind === "permitted") {
        return { permit: outcome.permit };
      }
      return {
        denied: deniedOutput(
          outcome.kind === "denied"
            ? outcome.reason
            : "Approval required but not yet resolved."
        ),
      };
    },
    async requiresApproval(call) {
      const decision = await authorization.check(
        requestFor(call, authoritySessionId)
      );
      return decision.kind === "ask";
    },
  };
}

function liveAuthorization(
  permission: HarnessPermissionCallback,
  authorization: Authorization,
  authoritySessionId?: string
): ToolAuthorization {
  return {
    async authorize(call, options) {
      const request = requestFor(call, authoritySessionId);
      const current = await authorization.check(request);
      if (current.kind === "deny") {
        return { denied: deniedOutput(current.reason) };
      }
      const result = await permission({
        capability: call.capability,
        input: call.input,
        sessionId: call.sessionId,
        signal: options.abortSignal ?? new AbortController().signal,
        source: call.source,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      });
      if (result.behavior !== "allow") {
        return { denied: deniedOutput(result.message) };
      }
      const outcome = await authorization.authorize(
        request,
        call.invocationId,
        {
          idempotent: true,
          openPending: false,
          ...(options.abortSignal === undefined
            ? {}
            : { signal: options.abortSignal }),
        }
      );
      if (outcome.kind === "permitted") {
        return { permit: outcome.permit };
      }
      return {
        denied: deniedOutput(
          outcome.kind === "denied"
            ? outcome.reason
            : "Approval required but not yet resolved."
        ),
      };
    },
    requiresApproval: () => Promise.resolve(false),
  };
}

export function compileTool(
  registration: HarnessToolRegistration,
  deps: ToolCompilerDeps
): Tool {
  const original = registration.tool;
  const originalExecute = original.execute;
  if (!originalExecute || isHarnessQuestionTool(original)) {
    return original;
  }

  const originalNeedsApproval = original.needsApproval;
  const authorization = deps.permission
    ? liveAuthorization(
        deps.permission,
        deps.authorization,
        deps.authoritySessionId
      )
    : standardAuthorization(deps.authorization, deps.authoritySessionId);
  const callFor = (
    input: unknown,
    options: { toolCallId: string; messages: ModelMessage[]; context: unknown }
  ): RegisteredToolCall =>
    registeredCallFor(registration, input, deps, {
      experimentalContext: options.context,
      messages: options.messages,
      toolCallId: options.toolCallId,
    });

  const needsApproval = async (
    input: unknown,
    options: {
      toolCallId: string;
      messages: ModelMessage[];
      context: unknown;
    }
  ): Promise<boolean> => {
    if (wasApprovalRequestedFor(options.toolCallId, options.messages)) {
      return true;
    }

    if (
      await resolveOriginalNeedsApproval(originalNeedsApproval, input, options)
    ) {
      return true;
    }

    return authorization.requiresApproval(callFor(input, options));
  };

  const execute = async (
    input: unknown,
    options: ToolExecutionOptions<unknown>
  ): Promise<unknown> => {
    const call = callFor(input, options);
    const { denied, permit } = await authorization.authorize(call, options);
    if (denied) {
      return denied;
    }
    try {
      if (permit?.signal.aborted) {
        throw permit.signal.reason;
      }
      const output = await originalExecute(
        input,
        permit ? { ...options, abortSignal: permit.signal } : options
      );
      keepToolOutput(output, registration.name, options.toolCallId);
      return output;
    } finally {
      permit?.release();
    }
  };

  const streamingExecute = async function* (
    input: unknown,
    options: ToolExecutionOptions<unknown>
  ): AsyncGenerator<unknown, void, undefined> {
    const call = callFor(input, options);
    const { denied, permit } = await authorization.authorize(call, options);
    if (denied) {
      yield denied;
      return;
    }
    try {
      if (permit?.signal.aborted) {
        throw permit.signal.reason;
      }
      let lastOutput: unknown;
      let yielded = false;
      for await (const output of originalExecute(
        input,
        permit ? { ...options, abortSignal: permit.signal } : options
      ) as AsyncIterable<unknown>) {
        lastOutput = output;
        yielded = true;
        yield output;
      }
      if (yielded) {
        keepToolOutput(lastOutput, registration.name, options.toolCallId);
      }
    } finally {
      permit?.release();
    }
  };

  const streaming = isAsyncGeneratorFunction(originalExecute);

  return {
    ...original,
    contextSchema: original.contextSchema ?? z.custom<unknown>(),
    execute: streaming ? streamingExecute : execute,
    needsApproval,
  };
}

function isAsyncGeneratorFunction(fn: unknown): boolean {
  return (
    Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]"
  );
}

export function compileTools(
  tools: ToolSet,
  deps: ToolCompilerDeps
): CompiledTools {
  return compileRegistrations(registrationsOf(tools, "declared"), deps);
}

export function compileRegistrations(
  registrations: HarnessToolRegistration[],
  deps: ToolCompilerDeps
): CompiledTools {
  const byName = new Map(registrations.map((r) => [r.name, r]));
  const tools: ToolSet = {};
  for (const registration of registrations) {
    tools[registration.name] = compileTool(registration, deps);
  }
  const registrationFor: CompiledTools["registrationFor"] = (
    toolName,
    input,
    call
  ) => {
    const registration = byName.get(toolName);
    if (!registration) {
      return;
    }
    return registeredCallFor(registration, input, deps, call);
  };
  return { registrationFor, tools };
}

export function withToolCallRegistration(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  registrationFor: CompiledTools["registrationFor"],
  call: Omit<ToolCallContext, "toolCallId">
): AsyncIterable<StreamPart> {
  const register = ({ input, toolCallId, toolName }: TypedToolCall<ToolSet>) =>
    registrationFor(toolName, input, { ...call, toolCallId });
  return mapAsyncIterable(stream, (part): StreamPart => {
    if (part.type === "tool-approval-request") {
      const registration = register(part.toolCall);
      return registration
        ? {
            ...part,
            agentGeneration: registration.agentGeneration,
            agentId: registration.agentId,
            capability: registration.capability,
          }
        : part;
    }
    if (part.type !== "tool-call") {
      return part;
    }
    const registration = register(part);
    if (!registration) {
      return part;
    }
    return {
      ...part,
      provenance: {
        agentGeneration: registration.agentGeneration,
        agentId: registration.agentId,
        capability: registration.capability,
        effectLocation: registration.effectLocation,
        invocationId: registration.invocationId,
        sessionId: registration.sessionId,
        source: registration.source,
      },
    };
  });
}

async function* mapAsyncIterable<T, U>(
  source: AsyncIterable<T>,
  fn: (item: T) => U
): AsyncIterable<U> {
  for await (const item of source) {
    yield fn(item);
  }
}
