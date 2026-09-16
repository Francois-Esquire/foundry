import type { ModelMessage, Tool, ToolExecutionOptions, ToolSet } from "ai";

import { z } from "zod";

import type {
  AgentAuthorizationRequest,
  AgentAuthorizer,
  Capability,
  ToolSource,
} from "../authorization";
import { agentSubject } from "../authorization";
import { createEventQueue } from "./event-queue";
import type {
  AgentInvocationContext,
  HarnessToolRegistration,
  RegisteredToolCall,
  ToolEffectLocation,
  ToolEffectPort,
} from "./types";
import { registrationsOf } from "./types";

/** Everything the compiler needs beyond the registrations themselves — the
 *  harness's own identity plus the authorization/effect boundaries it was
 *  built with (or defaulted to). */
export interface ToolCompilerDeps {
  /** The preset generation this harness was built from. Bumping it retires
   *  every Grant issued to the previous generation. */
  agentGeneration?: number;
  agentId: string;
  effectPort: ToolEffectPort;
  policy: AgentAuthorizer;
  sessionId?: string;
}

/** Per-call facts available when a chunk needs a capability but isn't going
 *  through `needsApproval`/`execute` itself. */
export interface ToolCallContext {
  experimentalContext?: unknown;
  messages: ModelMessage[];
  toolCallId: string;
}

export interface CompiledTools {
  registrationFor: (
    toolName: string,
    input: unknown,
    call: ToolCallContext
  ) => RegisteredToolCall | undefined;
  tools: ToolSet;
}

/** Denied-tool-call payload every compiled `execute` returns instead of
 *  running the real effect. Deliberately plain JSON, not an SDK-native
 *  "tool-output-denied" part (that type is reserved for the SDK's own
 *  human-declined-approval path) — the model reads it as an ordinary tool
 *  result and can choose another path (design: "denial is a tool result,
 *  not a failed Run"). */
export interface PolicyDeniedOutput {
  approved: false;
  reason: string;
}

function deniedOutput(reason: string): PolicyDeniedOutput {
  return { approved: false, reason };
}

/**
 * Stable `invocationId` for one logical tool call — namespaced by agent
 * (and session, when present) over the AI SDK's own `toolCallId`, which is
 * already durable across a replayed continuation (an approval resolution or
 * a suspend/resume re-runs `execute` with the same `toolCallId`, never a
 * fresh one). Deliberately not `randomUUID()`: an externally visible effect
 * keys idempotency on `invocationId` (design: "Effect boundary"), so a
 * replay must reproduce the same id, not mint a new one and risk a double
 * commit.
 */
function deriveInvocationId(
  deps: Pick<ToolCompilerDeps, "agentId" | "sessionId">,
  toolCallId: string
): string {
  return deps.sessionId
    ? `${deps.agentId}:${deps.sessionId}:${toolCallId}`
    : `${deps.agentId}:${toolCallId}`;
}

/** Build the one platform-agnostic call envelope before effect execution
 *  specializes. Callers describe effect ownership with `effectLocation`;
 *  terms such as browser, renderer, server, or client belong to adapters. */
export function registerToolCall<TInput>(args: {
  readonly agentId: string;
  readonly agentGeneration?: number;
  readonly sessionId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly source: ToolSource;
  readonly capability: Capability;
  readonly effectLocation: ToolEffectLocation;
  readonly input: TInput;
}): RegisteredToolCall<TInput> {
  return {
    agentId: args.agentId,
    invocationId: deriveInvocationId(args, args.toolCallId),
    ...(args.agentGeneration === undefined
      ? {}
      : { agentGeneration: args.agentGeneration }),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    capability: args.capability,
    effectLocation: args.effectLocation,
    input: args.input,
    source: args.source,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
  };
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
  return registerToolCall({
    agentId: deps.agentId,
    ...(deps.agentGeneration === undefined
      ? {}
      : { agentGeneration: deps.agentGeneration }),
    ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
    capability: registration.capability(
      input,
      buildCapabilityContext(deps, call)
    ),
    effectLocation: registrationEffectLocation(registration),
    input,
    source: registration.source,
    toolCallId: call.toolCallId,
    toolName: registration.name,
  });
}

function buildCapabilityContext(
  deps: ToolCompilerDeps,
  call: ToolCallContext
): AgentInvocationContext {
  return {
    agentId: deps.agentId,
    ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
    messages: call.messages,
    toolCallId: call.toolCallId,
    ...(call.experimentalContext === undefined
      ? {}
      : { experimentalContext: call.experimentalContext }),
  };
}

/**
 * The agent and tool identity a compiled call carries on its authorization
 * request's `context`. The decision never reads it — audit trails, approval
 * prompts, and traces do.
 */
export interface ToolAuthorizationContext {
  readonly agentId: string;
  readonly input: unknown;
  readonly sessionId?: string;
  readonly tool: { readonly name: string; readonly source: ToolSource };
}

/** Read the identity a compiled call attached, if this request came from one. */
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

/**
 * One tool call's ask, in the shared authorization vocabulary.
 *
 * The Subject is the agent preset, which is what stops two presets exposing the
 * same tool name from sharing authority. `scopeId` is the session, so a
 * session-lifetime Grant cannot leak into another session. The agent and tool
 * identity the audit trail needs rides on `context` — the decision itself is a
 * function of Subject and Capability alone.
 */
/**
 * Build the same request a compiled call builds, for a caller that must decide
 * about a tool the compiler never sees.
 *
 * A tool with no `execute` is passed through uncompiled, so its calls carry no
 * capability and reach no policy. A host that gates those itself must ask the
 * question in *exactly* the vocabulary the compiler would have used — the
 * Subject that scopes a Grant, the `scopeId` that stops one leaking across
 * sessions, and above all the `invocationId`, which is the claim-idempotency
 * key. Re-deriving that format by hand is how two callers silently disagree
 * about what one invocation is, so this exists to keep it defined once.
 *
 * `capability` is supplied rather than derived: the caller is answering for a
 * call it read off a persisted message, where the capability is already known
 * and no live registration is in hand.
 */
interface ToolAuthorizationRequestArgs {
  readonly agentGeneration?: number;
  readonly agentId: string;
  readonly capability: Capability;
  readonly input: unknown;
  readonly sessionId?: string;
  readonly tool: { readonly name: string; readonly source: ToolSource };
  readonly toolCallId: string;
}

export function toolAuthorizationRequest(
  args: ToolAuthorizationRequestArgs | RegisteredToolCall
): AgentAuthorizationRequest {
  const registered = "toolName" in args;
  const tool = registered
    ? { name: args.toolName, source: args.source }
    : args.tool;
  return {
    capability: args.capability,
    invocationId: registered
      ? args.invocationId
      : deriveInvocationId(
          {
            agentId: args.agentId,
            ...(args.sessionId ? { sessionId: args.sessionId } : {}),
          },
          args.toolCallId
        ),
    subject: agentSubject(args.agentId, args.agentGeneration),
    ...(args.sessionId ? { scopeId: args.sessionId } : {}),
    context: {
      agentId: args.agentId,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      input: args.input,
      tool,
    } satisfies ToolAuthorizationContext,
  };
}

/** Mirrors the AI SDK's own `isApprovalNeeded` (not exported publicly) so a
 *  registration's pre-existing `needsApproval` predicate keeps its original
 *  meaning once compiled. */
async function resolveOriginalNeedsApproval(
  needsApproval: Tool["needsApproval"],
  input: unknown,
  options: {
    toolCallId: string;
    messages: ModelMessage[];
    context: unknown;
  }
): Promise<boolean> {
  if (needsApproval == null) {
    return false;
  }
  if (typeof needsApproval === "boolean") {
    return needsApproval;
  }
  return await needsApproval(input, options);
}

/**
 * Sticky-replay recipe proven by the installed-SDK test (task-02's
 * `approval-sdk-replay.test.ts`): once a `tool-approval-request` has been
 * issued for a `toolCallId`, `needsApproval` must keep reporting true for
 * that call no matter what the *live* policy now says. The AI SDK's own
 * `validateApprovedToolApprovals` re-resolves `needsApproval` before
 * honoring a replayed approval, and drops a real approval as fabricated the
 * moment `needsApproval` stops agreeing — checking history first is what
 * keeps a later `"always"` grant from breaking a request already in flight.
 */
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

/**
 * A replayed approval is invocation authority for this exact tool call. The
 * SDK has already matched and validated the request/response pair before it
 * reaches `execute`; this local check prevents a second `approval-required`
 * policy lookup from turning a real one-time approval into a denial. Explicit
 * live denial still wins below, so revocation remains fail-closed.
 */
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

/**
 * Compile one {@link HarnessToolRegistration} into a real AI SDK {@link
 * Tool}. Preserves the original tool's schema, `toModelOutput`, metadata,
 * provider options, and any existing `needsApproval` predicate untouched;
 * adds capability derivation, policy consultation, approval-checkpoint
 * emission (via `needsApproval`, which is how the AI SDK's own tool loop
 * emits `tool-approval-request` and pauses before `execute`), and effect-
 * port invocation.
 *
 * Tools without an `execute` keep their SDK schema-only shape. Their streamed
 * calls are still registered by {@link withToolCallRegistration}; an embedding
 * host decides and claims them before performing the effect.
 */
export function compileTool(
  registration: HarnessToolRegistration,
  deps: ToolCompilerDeps
): Tool {
  const original = registration.tool;
  const originalExecute = original.execute;
  if (!originalExecute) {
    return original;
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated -- ai v7 moves tool approval to the call level; the harness still owns approval today (deferred migration)
  const originalNeedsApproval = original.needsApproval;

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

    const call = registeredCallFor(registration, input, deps, {
      experimentalContext: options.context,
      messages: options.messages,
      toolCallId: options.toolCallId,
    });
    // `decide` is repeatable and consumes nothing, which is what makes it safe
    // to run here as well as in `execute`. Authority is taken once, at the
    // effect boundary, by `claim`.
    const decision = await deps.policy.decide(toolAuthorizationRequest(call));
    return decision.kind === "requires-approval";
  };

  /** Decide, resolve a replayed approval, and claim — or produce the denial. */
  const authorize = async (
    input: unknown,
    options: ToolExecutionOptions<unknown>
  ): Promise<{ call: RegisteredToolCall } | { denied: unknown }> => {
    const call = registeredCallFor(registration, input, deps, {
      experimentalContext: options.context,
      messages: options.messages,
      toolCallId: options.toolCallId,
    });
    const request = toolAuthorizationRequest(call);
    let decision = await deps.policy.decide(request);
    const approvedReplay = wasApprovalGrantedFor(
      options.toolCallId,
      options.messages
    );

    if (decision.kind === "deny") {
      return { denied: deniedOutput(decision.reason) };
    }
    if (decision.kind === "requires-approval") {
      if (!approvedReplay) {
        // Unreachable in the normal flow — `needsApproval` above stops the AI
        // SDK from calling `execute` at all until a human resolves this.
        // Denied defensively anyway: no tool execute is reachable before
        // current authorization.
        return {
          denied: deniedOutput("Approval required but not yet resolved."),
        };
      }
      // The SDK has already matched and validated the request/response pair,
      // so this is a real human "yes" for this exact call. Resolving it here
      // turns it into invocation authority the claim below can take; leaving
      // it unresolved would make `claim` refuse it and turn a genuine approval
      // into a denial. `once` on purpose: a persisted answer is written by the
      // approval router, not manufactured from a replayed transcript.
      decision = await deps.policy.resolveApproval(request, { approved: true });
      if (decision.kind !== "allow") {
        return {
          denied: deniedOutput(
            decision.kind === "deny"
              ? decision.reason
              : "Approval required but not yet resolved."
          ),
        };
      }
    }

    // The effect boundary. Authority is consumed exactly here, idempotently by
    // `invocationId`, so a replayed continuation re-runs against its own claim
    // rather than spending a second one-shot Grant.
    const claim = await deps.policy.claim(request, decision);
    if (claim.kind !== "authorized") {
      return { denied: deniedOutput(claim.reason) };
    }
    return { call };
  };

  const execute = async (
    input: unknown,
    options: ToolExecutionOptions<unknown>
  ): Promise<unknown> => {
    const gate = await authorize(input, options);
    if ("denied" in gate) {
      return gate.denied;
    }
    return deps.effectPort.execute(gate.call, () =>
      Promise.resolve(originalExecute(input, options))
    );
  };

  // The AI SDK decides how to run a tool from `execute`'s *synchronous* return:
  // an async iterable streams interim results, anything else is awaited once.
  // Wrapping a generator tool in an async function would hand the SDK a
  // Promise of a generator — awaited to the generator object itself, never
  // iterated, serialized as `{}`. So a streaming tool compiles to a generator
  // that drains the original through the effect port, which then owns the
  // whole iteration rather than just its first tick.
  const streamingExecute = async function* (
    input: unknown,
    options: ToolExecutionOptions<unknown>
  ): AsyncGenerator<unknown, void, undefined> {
    const gate = await authorize(input, options);
    if ("denied" in gate) {
      yield gate.denied;
      return;
    }
    const queue = createEventQueue<unknown>();
    const effect = deps.effectPort
      .execute(gate.call, async () => {
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
    // AI SDK v7 only delivers `toolsContext` to tools that declare a context
    // schema. The harness hands every tool the same opaque, host-owned context
    // object, so this is a passthrough rather than a shape — validating it
    // would copy the object and break the identity hosts brand it with.
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

/**
 * Compile a plain tool map. Each tool's own `ToolMeta` (source,
 * capability, effect location) is honoured; untagged tools are `declared`
 * with the generic `tool.call` capability.
 */
export function compileTools(
  tools: ToolSet,
  deps: ToolCompilerDeps
): CompiledTools {
  return compileRegistrations(registrationsOf(tools, "declared"), deps);
}

/** Compile every registration into one {@link ToolSet}, plus a capability
 *  lookup the stream layer uses to label a raw approval-request chunk. */
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

/**
 * Stamp registration identity while the live compiler still has it.
 *
 * Schema-only host tools do not enter `execute`, so their streamed call is the
 * last common point before runtime and host effect ownership forks. Approval
 * chunks keep their existing top-level capability contract; ordinary calls
 * gain provenance that the Session layer can persist without reconstructing it
 * from a tool name later.
 */
export function withToolCallRegistration<
  T extends { type: string } & Record<string, unknown>,
>(
  stream: AsyncIterable<T>,
  registrationFor: CompiledTools["registrationFor"],
  call: {
    messages: ModelMessage[];
    experimentalContext?: unknown;
    agentId: string;
    agentGeneration?: number;
  }
): AsyncIterable<T> {
  return mapAsyncIterable(stream, (chunk) => {
    const toolCall = streamedToolCall(chunk);
    if (!toolCall) {
      return chunk;
    }
    const registration = registrationFor(toolCall.toolName, toolCall.input, {
      experimentalContext: call.experimentalContext,
      messages: call.messages,
      toolCallId: toolCall.toolCallId,
    });
    if (!registration) {
      return chunk;
    }

    if (chunk.type === "tool-approval-request") {
      return {
        ...chunk,
        agentId: call.agentId,
        capability: registration.capability,
        ...(call.agentGeneration === undefined
          ? {}
          : { agentGeneration: call.agentGeneration }),
      };
    }

    return {
      ...chunk,
      provenance: {
        agentId: registration.agentId,
        capability: registration.capability,
        effectLocation: registration.effectLocation,
        invocationId: registration.invocationId,
        source: registration.source,
        ...(registration.agentGeneration === undefined
          ? {}
          : { agentGeneration: registration.agentGeneration }),
        ...(registration.sessionId
          ? { sessionId: registration.sessionId }
          : {}),
      },
    };
  });
}

function streamedToolCall(
  chunk: { type: string } & Record<string, unknown>
): { toolCallId: string; toolName: string; input: unknown } | undefined {
  if (chunk.type === "tool-call") {
    const toolCallId = stringField(chunk, "toolCallId");
    const toolName =
      stringField(chunk, "toolName") ?? stringField(chunk, "name");
    if (!(toolCallId && toolName)) {
      return undefined;
    }
    return { input: chunk.input ?? chunk.args, toolCallId, toolName };
  }
  if (chunk.type !== "tool-approval-request") {
    return undefined;
  }
  const nested = chunk.toolCall;
  if (typeof nested !== "object" || nested === null) {
    return undefined;
  }
  const toolCall = nested as Record<string, unknown>;
  const toolCallId = stringField(toolCall, "toolCallId");
  const toolName = stringField(toolCall, "toolName");
  if (!(toolCallId && toolName)) {
    return undefined;
  }
  return { input: toolCall.input, toolCallId, toolName };
}

function stringField(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

async function* mapAsyncIterable<T>(
  source: AsyncIterable<T>,
  fn: (item: T) => T
): AsyncIterable<T> {
  for await (const item of source) {
    yield fn(item);
  }
}
