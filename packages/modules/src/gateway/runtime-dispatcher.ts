import type { ModuleCapabilityRequest } from "../manifest";
import { capabilityIdentity } from "../manifest";
import type { ModuleGatewayContext, ModuleStore } from "../store/contract";
import { ModuleGatewayContractError } from "./catalog";
import { admitRuntimeContext } from "./runtime-context";
import type {
  ModuleCapabilityInvocationContext,
  ModuleCapabilityProvider,
  ModuleGatewayDispatchResult,
  ModuleGatewayInvocationEnd,
  ModuleGatewayInvocationRecord,
  ModuleGatewayRuntimeDispatcher,
  ModulePrincipal,
  ModuleRuntimeIdentity,
  ModuleStreamCapabilityRegistration,
  ModuleUnaryCapabilityRegistration,
} from "./types";
import { ModuleGatewayError } from "./types";

export interface CreateModuleGatewayRuntimeDispatcherOptions {
  /** The clock invocation records are stamped with. */
  readonly now?: () => Date;
  /**
   * Told of each invocation of an admitted runtime: once when it settles,
   * and also when a stream opens. Fail-soft: it can neither delay nor fail
   * the invocation.
   */
  readonly observe?: (record: ModuleGatewayInvocationRecord) => void;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly store: ModuleStore;
}

/**
 * The sole runtime admission path. It deliberately holds no approval surface:
 * a request is either already granted or it fails before an effect begins.
 */
export function createModuleGatewayRuntimeDispatcher(
  options: CreateModuleGatewayRuntimeDispatcherOptions
): ModuleGatewayRuntimeDispatcher {
  const providers = providerIndex(options.providers);
  const active = new Set<ActiveInvocation>();
  const observe = invocationObserver(options.observe);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  return Object.freeze({
    dispatch: async (
      input: Parameters<ModuleGatewayRuntimeDispatcher["dispatch"]>[0]
    ): Promise<ModuleGatewayDispatchResult> => {
      const { runtime, request } = input;
      const selection = input.capabilities.find(
        (capability) => capability.alias === request.alias
      );
      // Registered before the Grants are read: a revoke that commits after
      // the read still finds it and cancels it before any effect.
      const cancellation = trackInvocation({
        active,
        callerSignal: input.signal,
        capability: selection?.capability,
        installationId: runtime.installationId,
      });
      let context: ModuleGatewayContext;
      try {
        context = await admitRuntimeContext(options.store, runtime);
      } catch (error) {
        cancellation.cleanup();
        throw error;
      }
      const principal: ModulePrincipal = Object.freeze({
        contentId: runtime.contentId,
        generation: runtime.generation,
        installationId: context.installation.id,
        moduleId: context.installation.moduleId,
        runtimeInstanceId: runtime.runtimeInstanceId,
      });
      const invocationId = `runtime:${runtime.runtimeInstanceId}:request:${request.id}`;
      const record = {
        ...(selection === undefined
          ? {}
          : {
              capability: {
                name: selection.capability,
                version: selection.version,
              },
            }),
        invocationId,
        mode: request.mode,
        principal,
        startedAt: now(),
      };
      const settle = (error?: unknown) =>
        observe({ ...record, ...outcome(error, now()) });
      let result: ModuleGatewayDispatchResult;
      try {
        result = await dispatchAdmitted(input, {
          cancellation,
          invocationId,
          principal,
          selection,
        });
      } catch (error) {
        cancellation.cleanup();
        settle(error);
        throw error;
      }
      if (result.mode === "unary") {
        settle();
        return result;
      }
      observe({ ...record, status: "running" });
      return { ...result, events: observed(result.events, settle) };
    },
    revoke: ({
      installationId,
      capability,
      reason,
    }: Parameters<ModuleGatewayRuntimeDispatcher["revoke"]>[0]) => {
      for (const invocation of active) {
        if (
          invocation.installationId === installationId &&
          invocation.capability === capability
        ) {
          invocation.controller.abort(reason);
        }
      }
    },
  });

  async function dispatchAdmitted(
    input: Parameters<ModuleGatewayRuntimeDispatcher["dispatch"]>[0],
    admitted: {
      readonly cancellation: TrackedInvocation;
      readonly invocationId: string;
      readonly principal: ModulePrincipal;
      readonly selection: (typeof input.capabilities)[number] | undefined;
    }
  ): Promise<ModuleGatewayDispatchResult> {
    const { request } = input;
    const { cancellation, invocationId, principal, selection } = admitted;
    if (selection === undefined) {
      throw failure(
        "unknown-alias",
        "Gateway capability alias is not declared"
      );
    }
    const provider = providers.get(
      capabilityIdentity(selection.capability, selection.version)
    );
    if (provider === undefined) {
      throw failure("unknown-capability", "Gateway capability is unavailable");
    }
    const { registration } = provider;
    if (registration.mode !== request.mode) {
      throw failure("invalid-frame", "Gateway capability mode is invalid");
    }

    let parsedInput: unknown;
    try {
      parsedInput = registration.input.parse(request.input);
    } catch (cause) {
      throw failure("invalid-input", "Gateway capability input is invalid", {
        cause,
      });
    }
    await untilCancelled(
      authorizeInvocation({
        principal,
        provider,
        runtime: input.runtime,
        selection,
        store: options.store,
      }),
      cancellation.signal
    );
    assertNotCancelled(cancellation.signal);

    const invocation: ModuleCapabilityInvocationContext = {
      constraints: selection.constraints ?? null,
      invocationId,
      principal,
      signal: cancellation.signal,
    };
    if (registration.mode === "unary") {
      try {
        return await dispatchUnary(registration, parsedInput, invocation);
      } finally {
        cancellation.cleanup();
      }
    }
    return {
      events: withCleanup(
        dispatchStream(registration, parsedInput, invocation),
        cancellation.cleanup
      ),
      mode: "stream" as const,
    };
  }
}

/** The observer, made fail-soft. */
function invocationObserver(
  observer: ((record: ModuleGatewayInvocationRecord) => void) | undefined
): (record: ModuleGatewayInvocationRecord) => void {
  return (record) => {
    try {
      observer?.(record);
    } catch (error) {
      console.error("[modules] invocation observer failed:", error);
    }
  };
}

/** How an invocation ended, from what it threw (nothing: complete). */
function outcome(error: unknown, endedAt: string): ModuleGatewayInvocationEnd {
  if (error === undefined) {
    return { endedAt, status: "complete" };
  }
  if (!(error instanceof ModuleGatewayError)) {
    return { endedAt, status: "failed" };
  }
  if (error.code === "unauthorized") {
    return { endedAt, errorCode: error.code, status: "denied" };
  }
  return {
    endedAt,
    errorCode: error.code,
    status: error.code === "cancelled" ? "cancelled" : "failed",
  };
}

/** A stream that reports how it ended; a reader that stops early cancelled it. */
async function* observed(
  events: AsyncIterable<unknown>,
  settle: (error?: unknown) => void
): AsyncIterable<unknown> {
  let settled = false;
  try {
    yield* events;
    settled = true;
    settle();
  } catch (error) {
    settled = true;
    settle(error);
    throw error;
  } finally {
    if (!settled) {
      settle(
        new ModuleGatewayError("cancelled", "Gateway request was cancelled")
      );
    }
  }
}

interface ActiveInvocation {
  /** Absent for an undeclared alias, which no revoke names. */
  readonly capability: string | undefined;
  readonly controller: AbortController;
  readonly installationId: ModulePrincipal["installationId"];
}

/** An invocation a revoke or its caller can cancel; `cleanup` is idempotent. */
interface TrackedInvocation {
  readonly cleanup: () => void;
  readonly signal: AbortSignal;
}

function trackInvocation(input: {
  readonly active: Set<ActiveInvocation>;
  readonly installationId: ModulePrincipal["installationId"];
  readonly capability: string | undefined;
  readonly callerSignal: AbortSignal;
}): TrackedInvocation {
  const controller = new AbortController();
  const invocation: ActiveInvocation = {
    capability: input.capability,
    controller,
    installationId: input.installationId,
  };
  const relayCallerAbort = () => {
    controller.abort(input.callerSignal.reason);
  };
  if (input.callerSignal.aborted) {
    relayCallerAbort();
  } else {
    input.callerSignal.addEventListener("abort", relayCallerAbort, {
      once: true,
    });
  }
  input.active.add(invocation);
  return {
    cleanup: () => {
      input.active.delete(invocation);
      input.callerSignal.removeEventListener("abort", relayCallerAbort);
    },
    signal: controller.signal,
  };
}

/**
 * Settles with `work`, or rejects as cancelled once `signal` aborts, so a
 * provider that never answers cannot hold a cancelled request open.
 */
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(failure("cancelled", "Gateway request was cancelled"));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function* withCleanup(
  events: AsyncIterable<unknown>,
  cleanup: () => void
): AsyncIterable<unknown> {
  try {
    yield* events;
  } finally {
    cleanup();
  }
}

/**
 * Resolves the provider's constraints, then checks Grants read afterwards, so
 * a Grant removed while the provider was deciding is never honored.
 */
async function authorizeInvocation(input: {
  readonly store: ModuleStore;
  readonly runtime: ModuleRuntimeIdentity;
  readonly provider: ModuleCapabilityProvider;
  readonly selection: ModuleCapabilityRequest;
  readonly principal: ModulePrincipal;
}): Promise<void> {
  const { selection } = input;
  let constraintsDigest: string;
  try {
    ({ constraintsDigest } = await input.provider.resolveConstraints({
      principal: input.principal,
      releaseConstraints: selection.constraints ?? null,
    }));
  } catch (cause) {
    throw failure("unauthorized", "Gateway capability constraints are denied", {
      cause,
    });
  }
  if (
    typeof constraintsDigest !== "string" ||
    constraintsDigest.trim().length === 0
  ) {
    throw failure("unauthorized", "Gateway capability constraints are denied");
  }
  const current = await admitRuntimeContext(input.store, input.runtime);
  const granted = current.grants.some(
    (grant) =>
      grant.capability === selection.capability &&
      grant.version === selection.version &&
      grant.constraintsDigest === constraintsDigest
  );
  if (!granted) {
    throw failure("unauthorized", "Gateway capability is not granted");
  }
}

async function dispatchUnary(
  registration: ModuleUnaryCapabilityRegistration<unknown, unknown>,
  input: unknown,
  invocation: ModuleCapabilityInvocationContext
): Promise<ModuleGatewayDispatchResult> {
  try {
    assertNotCancelled(invocation.signal);
    const output = await registration.invoke(input, invocation);
    assertNotCancelled(invocation.signal);
    return { mode: "unary", output: registration.output.parse(output) };
  } catch (error) {
    if (error instanceof ModuleGatewayError) {
      throw error;
    }
    throw providerFailure(invocation.signal);
  }
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw failure("cancelled", "Gateway request was cancelled");
  }
}

async function* dispatchStream(
  registration: ModuleStreamCapabilityRegistration<unknown, unknown>,
  input: unknown,
  invocation: ModuleCapabilityInvocationContext
): AsyncIterable<unknown> {
  try {
    assertNotCancelled(invocation.signal);
    for await (const event of registration.invoke(input, invocation)) {
      if (isAborted(invocation.signal)) {
        throw failure("cancelled", "Gateway request was cancelled");
      }
      yield registration.event.parse(event);
    }
    // A provider that ends because its signal aborted was cancelled, not completed.
    if (isAborted(invocation.signal)) {
      throw failure("cancelled", "Gateway request was cancelled");
    }
  } catch (error) {
    if (error instanceof ModuleGatewayError) {
      throw error;
    }
    throw providerFailure(invocation.signal);
  }
}

/**
 * A pre-loop `aborted` check narrows the flag to `false` for the rest of the
 * block, so the signal has to be re-read behind a call to see a later abort.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function providerFailure(signal: AbortSignal): ModuleGatewayError {
  return signal.aborted
    ? failure("cancelled", "Gateway request was cancelled")
    : failure("provider-failure", "Gateway provider failed");
}

function providerIndex(
  providers: readonly ModuleCapabilityProvider[]
): ReadonlyMap<string, ModuleCapabilityProvider> {
  const index = new Map<string, ModuleCapabilityProvider>();
  for (const provider of providers) {
    const key = capabilityIdentity(
      provider.registration.descriptor.capability,
      provider.registration.descriptor.version
    );
    if (index.has(key)) {
      throw new ModuleGatewayContractError(
        "Gateway provider is registered more than once"
      );
    }
    index.set(key, provider);
  }
  return index;
}

function failure(
  code: ConstructorParameters<typeof ModuleGatewayError>[0],
  message: string,
  options?: ErrorOptions
): ModuleGatewayError {
  return new ModuleGatewayError(code, message, options);
}
