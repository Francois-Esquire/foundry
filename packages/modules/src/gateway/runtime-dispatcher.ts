import { capabilityIdentity } from "../manifest";
import type { ModuleGatewayContext, ModuleStore } from "../store/contract";
import { ModuleGatewayContractError } from "./catalog";
import { loadRuntimeGatewayContext, staleRuntime } from "./runtime-context";
import type {
  ModuleCapabilityInvocationContext,
  ModuleCapabilityProvider,
  ModuleGatewayDispatchResult,
  ModuleGatewayRuntimeDispatcher,
  ModulePrincipal,
  ModuleRuntimeIdentity,
  ModuleStreamCapabilityRegistration,
  ModuleUnaryCapabilityRegistration,
} from "./types";
import { ModuleGatewayError } from "./types";

export interface CreateModuleGatewayRuntimeDispatcherOptions {
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
  return Object.freeze({
    dispatch: async (
      input: Parameters<ModuleGatewayRuntimeDispatcher["dispatch"]>[0]
    ): Promise<ModuleGatewayDispatchResult> => {
      const { runtime, request, signal } = input;
      const context = await admitRuntimeContext(options.store, runtime);
      const selection = input.capabilities.find(
        (capability) => capability.alias === request.alias
      );
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
        throw failure(
          "unknown-capability",
          "Gateway capability is unavailable"
        );
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
      const principal: ModulePrincipal = Object.freeze({
        contentId: runtime.contentId,
        generation: runtime.generation,
        installationId: context.installation.id,
        moduleId: context.installation.moduleId,
        runtimeInstanceId: runtime.runtimeInstanceId,
      });
      let constraintsDigest: string;
      try {
        ({ constraintsDigest } = await provider.resolveConstraints({
          principal,
          releaseConstraints: selection.constraints ?? null,
        }));
      } catch (cause) {
        throw failure(
          "unauthorized",
          "Gateway capability constraints are denied",
          { cause }
        );
      }
      if (
        typeof constraintsDigest !== "string" ||
        constraintsDigest.trim().length === 0
      ) {
        throw failure(
          "unauthorized",
          "Gateway capability constraints are denied"
        );
      }
      const granted = context.grants.some(
        (grant) =>
          grant.capability === selection.capability &&
          grant.version === selection.version &&
          grant.constraintsDigest === constraintsDigest
      );
      if (!granted) {
        throw failure("unauthorized", "Gateway capability is not granted");
      }

      const cancellation = trackInvocation({
        active,
        callerSignal: signal,
        capability: selection.capability,
        installationId: context.installation.id,
      });
      const invocation: ModuleCapabilityInvocationContext = {
        constraints: selection.constraints ?? null,
        invocationId: `runtime:${runtime.runtimeInstanceId}:request:${request.id}`,
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
}

interface ActiveInvocation {
  readonly capability: string;
  readonly controller: AbortController;
  readonly installationId: ModulePrincipal["installationId"];
}

function trackInvocation(input: {
  readonly active: Set<ActiveInvocation>;
  readonly installationId: ModulePrincipal["installationId"];
  readonly capability: string;
  readonly callerSignal: AbortSignal;
}): {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
} {
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

async function admitRuntimeContext(
  store: ModuleStore,
  runtime: ModuleRuntimeIdentity
): Promise<ModuleGatewayContext> {
  const context = await loadRuntimeGatewayContext(store, runtime);
  const { status } = context.installation;
  if (status !== "starting" && status !== "active") {
    throw staleRuntime(runtime, `Installation is ${status}`);
  }
  return context;
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
