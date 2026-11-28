import type { Authorization, GrantId, Permit } from "@foundry/authorization";
import { withAbort } from "@foundry/lib/abort";
import {
  grantToInstallationGrant,
  MODULE_CAPABILITY_ACTION,
  moduleCapabilityAccessRequest,
  moduleInstallationPrincipal,
  resolveCapabilityDigest,
} from "../grants";
import type { ModuleCapabilityRequest } from "../manifest";
import { capabilityIdentity } from "../manifest";
import type { ModuleCommands, ModuleGatewayContext } from "../modules";
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
  readonly authorization?: Authorization;
  readonly now?: () => Date;
  readonly observe?: (record: ModuleGatewayInvocationRecord) => void;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly store: ModuleCommands;
}

export function createModuleGatewayRuntimeDispatcher(
  options: CreateModuleGatewayRuntimeDispatcherOptions
): ModuleGatewayRuntimeDispatcher {
  const authorization = options.authorization ?? options.store.authorization;
  const providers = providerIndex(options.providers);
  const admissions = new Set<{
    readonly capability: string;
    readonly controller: AbortController;
    readonly installationId: string;
  }>();
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
      const context: ModuleGatewayContext = await admitRuntimeContext(
        options.store,
        runtime
      );
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
      let dispatched: DispatchedInvocation;
      try {
        dispatched = await dispatchAdmitted(input, {
          invocationId,
          principal,
          selection,
        });
      } catch (error) {
        settle(error);
        throw error;
      }
      if (dispatched.result.mode === "unary") {
        settle();
        return dispatched.result;
      }
      observe({ ...record, status: "running" });
      return {
        ...dispatched.result,
        events: observedStream(
          dispatched.result.events,
          dispatched.permit,
          settle
        ),
      };
    },
    revoke: ({
      installationId,
      capability,
      reason,
    }: Parameters<ModuleGatewayRuntimeDispatcher["revoke"]>[0]) => {
      for (const pending of admissions) {
        if (
          pending.installationId === installationId &&
          pending.capability === capability
        ) {
          pending.controller.abort(reason ?? "Grant revoked");
        }
      }
    },
  });

  async function dispatchAdmitted(
    input: Parameters<ModuleGatewayRuntimeDispatcher["dispatch"]>[0],
    admitted: {
      readonly invocationId: string;
      readonly principal: ModulePrincipal;
      readonly selection: (typeof input.capabilities)[number] | undefined;
    }
  ): Promise<DispatchedInvocation> {
    const { request } = input;
    const { invocationId, principal, selection } = admitted;
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

    const permit = await authorizeInvocation({
      admissions,
      authorization,
      callerSignal: input.signal,
      invocationId,
      principal,
      provider,
      runtime: input.runtime,
      selection,
      store: options.store,
    });

    const invocation: ModuleCapabilityInvocationContext = {
      constraints: selection.constraints ?? null,
      invocationId,
      principal,
      signal: permit.signal,
    };
    if (registration.mode === "unary") {
      try {
        const result = await dispatchUnary(
          registration,
          parsedInput,
          invocation
        );
        return { permit, result };
      } finally {
        permit.release();
      }
    }
    return {
      permit,
      result: {
        events: dispatchStream(registration, parsedInput, invocation),
        mode: "stream" as const,
      },
    };
  }
}

interface DispatchedInvocation {
  readonly permit: Permit;
  readonly result: ModuleGatewayDispatchResult;
}

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

function observedStream(
  events: AsyncIterable<unknown>,
  permit: Permit,
  settle: (error?: unknown) => void
): AsyncIterable<unknown> {
  let finished = false;
  let reading = false;
  function finish(error?: unknown) {
    if (finished) {
      return;
    }
    finished = true;
    permit.signal.removeEventListener("abort", cancelUnread);
    permit.release();
    settle(error);
  }
  function cancelUnread() {
    if (!reading) {
      finish(failure("cancelled", "Gateway request was cancelled"));
    }
  }
  if (permit.signal.aborted) {
    cancelUnread();
  } else {
    permit.signal.addEventListener("abort", cancelUnread, {
      once: true,
    });
  }
  return (async function* read() {
    reading = true;
    let ended = false;
    try {
      yield* events;
      ended = true;
      finish();
    } catch (error) {
      ended = true;
      finish(error);
      throw error;
    } finally {
      if (!ended) {
        finish(failure("cancelled", "Gateway request was cancelled"));
      }
    }
  })();
}

async function authorizeInvocation(input: {
  readonly admissions: Set<{
    readonly capability: string;
    readonly controller: AbortController;
    readonly installationId: string;
  }>;
  readonly authorization: Authorization;
  readonly callerSignal: AbortSignal;
  readonly invocationId: string;
  readonly store: ModuleCommands;
  readonly runtime: ModuleRuntimeIdentity;
  readonly provider: ModuleCapabilityProvider;
  readonly selection: ModuleCapabilityRequest;
  readonly principal: ModulePrincipal;
}): Promise<Permit> {
  const { admissions, authorization, callerSignal, selection } = input;
  assertNotCancelled(callerSignal);

  const candidateGrants = await authorization.listGrants({
    action: MODULE_CAPABILITY_ACTION,
    principal: moduleInstallationPrincipal(input.principal.installationId),
    state: "active",
  });
  const candidateGrantIds = new Set<GrantId>(
    candidateGrants
      .filter(
        (grant) =>
          grantToInstallationGrant(grant)?.capability === selection.capability
      )
      .map((grant) => grant.id)
  );

  const admission = new AbortController();
  const admissionEntry = {
    capability: selection.capability,
    controller: admission,
    installationId: input.principal.installationId,
  };
  admissions.add(admissionEntry);
  const relayCallerAbort = () => admission.abort(callerSignal.reason);
  if (callerSignal.aborted) {
    relayCallerAbort();
  } else {
    callerSignal.addEventListener("abort", relayCallerAbort, { once: true });
  }
  const unwatch = authorization.watch((event) => {
    if (
      event.type === "grant.revoked" &&
      event.grantIds.some((id) => candidateGrantIds.has(id))
    ) {
      admission.abort(event.reason ?? "Grant revoked");
    }
  });

  let constraintsDigest: string;
  try {
    constraintsDigest = await withAbort(
      resolveConstraints(input.provider, input.principal, selection),
      admission.signal,
      () => failure("cancelled", "Gateway request was cancelled")
    );
    assertNotCancelled(admission.signal);
  } finally {
    admissions.delete(admissionEntry);
    unwatch();
    callerSignal.removeEventListener("abort", relayCallerAbort);
  }

  await admitRuntimeContext(input.store, input.runtime);
  assertNotCancelled(callerSignal);

  const decision = await authorization.authorize(
    moduleCapabilityAccessRequest({
      capability: selection.capability,
      constraintsDigest,
      installationId: input.principal.installationId,
      version: selection.version,
    }),
    input.invocationId,
    { openPending: false, signal: callerSignal }
  );
  if (decision.kind !== "permitted") {
    assertNotCancelled(callerSignal);
    throw failure("unauthorized", "Gateway capability is not granted");
  }
  if (decision.permit.signal.aborted) {
    decision.permit.release();
    throw failure("cancelled", "Gateway request was cancelled");
  }
  return decision.permit;
}

async function resolveConstraints(
  provider: ModuleCapabilityProvider,
  principal: ModulePrincipal,
  selection: ModuleCapabilityRequest
): Promise<string> {
  try {
    return await resolveCapabilityDigest(
      provider,
      principal,
      selection.constraints
    );
  } catch (cause) {
    throw failure("unauthorized", "Gateway capability constraints are denied", {
      cause,
    });
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
