import type {
  ModelMessage,
  TextStreamPart,
  Tool,
  ToolExecutionOptions,
  ToolSet,
  TypedToolCall,
} from "ai";

import { z } from "zod";

import type {
  AgentAuthorizationRequest,
  AgentAuthorizer,
} from "../authorization/authorization";
import { agentSubject } from "../authorization/authorization";
import type { Capability, ToolSource } from "../authorization/capability";
import { createEventQueue } from "./event-queue";
import { isHarnessQuestionTool } from "./question";
import type { StreamPart } from "./stream-transform";
import type { HarnessPermissionCallback } from "./turn-driver";
import type {
  AgentIdentity,
  AgentInvocationContext,
  HarnessToolRegistration,
  RegisteredToolCall,
  ToolEffectLocation,
  ToolEffectPort,
} from "./types";
import { registrationsOf } from "./types";

export interface ToolCompilerDeps extends AgentIdentity {
  effectPort: ToolEffectPort;
  permission?: HarnessPermissionCallback;
  policy: AgentAuthorizer;
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

function deriveInvocationId(
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

export interface ToolAuthorizationContext {
  readonly agentId: string;
  readonly input: unknown;
  readonly sessionId?: string;
  readonly tool: { readonly name: string; readonly source: ToolSource };
}

export function toolAuthorizationContext(
  request: AgentAuthorizationRequest
): ToolAuthorizationContext | undefined {
  const { context } = request;
  if (typeof context !== "object" || context === null) {
    return undefined;
  }
  const candidate = context as Partial<ToolAuthorizationContext>;
  return typeof candidate.agentId === "string" && candidate.tool
    ? (candidate as ToolAuthorizationContext)
    : undefined;
}

interface ToolAuthorizationRequestArgs extends AgentIdentity {
  readonly capability: Capability;
  readonly input: unknown;
  readonly tool: { readonly name: string; readonly source: ToolSource };
  readonly toolCallId: string;
}

export function toolAuthorizationRequest(
  args: ToolAuthorizationRequestArgs
): AgentAuthorizationRequest {
  return {
    capability: args.capability,
    context: {
      agentId: args.agentId,
      input: args.input,
      sessionId: args.sessionId,
      tool: args.tool,
    } satisfies ToolAuthorizationContext,
    invocationId: deriveInvocationId(args, args.toolCallId),
    scopeId: args.sessionId,
    subject: agentSubject(args.agentId, args.agentGeneration),
  };
}

function requestFor(call: RegisteredToolCall): AgentAuthorizationRequest {
  return toolAuthorizationRequest({
    ...call,
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

interface ToolAuthorization {
  authorize(
    call: RegisteredToolCall,
    options: ToolExecutionOptions<unknown>
  ): Promise<PolicyDeniedOutput | undefined>;
  requiresApproval(call: RegisteredToolCall): Promise<boolean>;
}

function policyAuthorization(policy: AgentAuthorizer): ToolAuthorization {
  return {
    async authorize(call, options) {
      const request = requestFor(call);
      let decision = await policy.decide(request);
      if (decision.kind === "deny") {
        return deniedOutput(decision.reason);
      }
      if (decision.kind === "requires-approval") {
        if (!wasApprovalGrantedFor(options.toolCallId, options.messages)) {
          return deniedOutput("Approval required but not yet resolved.");
        }
        decision = await policy.resolveApproval(request, { approved: true });
        if (decision.kind !== "allow") {
          return deniedOutput(
            decision.kind === "deny"
              ? decision.reason
              : "Approval required but not yet resolved."
          );
        }
      }

      const claim = await policy.claim(request, decision);
      return claim.kind === "authorized"
        ? undefined
        : deniedOutput(claim.reason);
    },
    async requiresApproval(call) {
      const decision = await policy.decide(requestFor(call));
      return decision.kind === "requires-approval";
    },
  };
}

function liveAuthorization(
  permission: HarnessPermissionCallback,
  policy: AgentAuthorizer
): ToolAuthorization {
  return {
    async authorize(call, options) {
      const current = await policy.decide(requestFor(call));
      if (current.kind === "deny") {
        return deniedOutput(current.reason);
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
      return result.behavior === "allow"
        ? undefined
        : deniedOutput(result.message);
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
    ? liveAuthorization(deps.permission, deps.policy)
    : policyAuthorization(deps.policy);
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
    const denied = await authorization.authorize(call, options);
    if (denied) {
      return denied;
    }
    return deps.effectPort.execute(call, () =>
      Promise.resolve(originalExecute(input, options))
    );
  };

  const streamingExecute = async function* (
    input: unknown,
    options: ToolExecutionOptions<unknown>
  ): AsyncGenerator<unknown, void, undefined> {
    const call = callFor(input, options);
    const denied = await authorization.authorize(call, options);
    if (denied) {
      yield denied;
      return;
    }
    const queue = createEventQueue<unknown>();
    const effect = deps.effectPort
      .execute(call, async () => {
        const iterable = originalExecute(
          input,
          options
        ) as AsyncIterable<unknown>;
        for await (const item of iterable) {
          queue.push(item);
        }
      })
      .finally(() => {
        queue.close();
      });
    const iterator = queue.iterator();
    for (
      let next = await iterator.next();
      !next.done;
      next = await iterator.next()
    ) {
      yield next.value;
    }
    await effect;
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
