import type { ContentId } from "@foundry/artifacts";

import type { InstallationId, ModuleId, RuntimeInstanceId } from "../domain";
import type { ModuleCapabilityRequest, PortableSchema } from "../manifest";

export interface ModuleRuntimeIdentity {
  readonly contentId: ContentId;
  readonly generation: number;
  readonly installationId: InstallationId;
  readonly runtimeInstanceId: RuntimeInstanceId;
}

export interface ModulePrincipal extends ModuleRuntimeIdentity {
  readonly moduleId: ModuleId;
}

export type ModuleConstraintsPrincipal = Omit<
  ModulePrincipal,
  "runtimeInstanceId"
>;

export interface ModuleTransport {
  close(reason: string): Promise<void>;
  readonly closed: Promise<void>;
  readonly incoming: AsyncIterable<unknown>;
  send(frame: unknown): Promise<void>;
}

export type ModuleGatewaySessionMode = "development" | "runtime";

export interface ModuleGatewayDevelopmentBinding {
  readonly catalog: ModuleCapabilityCatalog;
  readonly developmentId: string;
  readonly mode: "development";
}

export interface ModuleGatewayRuntimeBinding {
  readonly capabilities: readonly ModuleCapabilityRequest[];
  readonly mode: "runtime";
  readonly moduleId: ModuleId;
  readonly runtime: ModuleRuntimeIdentity;
}

export type ModuleGatewayBinding =
  | ModuleGatewayDevelopmentBinding
  | ModuleGatewayRuntimeBinding;

export interface ModuleGatewayHelloFrame {
  readonly binding:
    | { readonly developmentId: string }
    | {
        readonly installationId: InstallationId;
        readonly moduleId: ModuleId;
        readonly releaseId: ContentId;
        readonly runtimeInstanceId: RuntimeInstanceId;
        readonly generation: number;
      };
  readonly kind: "hello";
  readonly mode: ModuleGatewaySessionMode;
  readonly protocol: 1;
}

export interface ModuleGatewayReadyFrame {
  readonly kind: "ready";
  readonly mode: ModuleGatewaySessionMode;
  readonly protocol: 1;
}

export interface ModuleGatewayInvocationFrame {
  readonly alias: string;
  readonly id: string;
  readonly input: unknown;
  readonly kind: "invoke";
  readonly mode: ModuleCapabilityMode;
}

export interface ModuleGatewayCancelFrame {
  readonly id: string;
  readonly kind: "cancel";
}

export interface ModuleGatewayHeartbeatFrame {
  readonly kind: "heartbeat";
  readonly sequence: number;
}

export interface ModuleGatewayShutdownFrame {
  readonly kind: "shutdown";
  readonly reason: string;
}

export type ModuleGatewayProgramFrame =
  | ModuleGatewayReadyFrame
  | ModuleGatewayInvocationFrame
  | ModuleGatewayCancelFrame
  | ModuleGatewayHeartbeatFrame
  | ModuleGatewayShutdownFrame;

export interface ModuleGatewayCatalogSnapshotFrame {
  readonly catalog: ModuleCapabilityCatalog;
  readonly kind: "catalog.snapshot";
}

export interface ModuleGatewayCatalogChangedFrame {
  readonly kind: "catalog.changed";
  readonly revision: string;
}

export interface ModuleGatewayResultFrame {
  readonly id: string;
  readonly kind: "result";
  readonly output: unknown;
}

export interface ModuleGatewayNextFrame {
  readonly event: unknown;
  readonly id: string;
  readonly kind: "next";
}

export interface ModuleGatewayCompleteFrame {
  readonly id: string;
  readonly kind: "complete";
}

export interface ModuleGatewayFailureFrame {
  readonly code: ModuleGatewayFailureCode;
  readonly id: string;
  readonly kind: "failure";
  readonly message: string;
}

export type ModuleGatewayHostFrame =
  | ModuleGatewayHelloFrame
  | ModuleGatewayCatalogSnapshotFrame
  | ModuleGatewayCatalogChangedFrame
  | ModuleGatewayResultFrame
  | ModuleGatewayNextFrame
  | ModuleGatewayCompleteFrame
  | ModuleGatewayFailureFrame
  | ModuleGatewayHeartbeatFrame
  | ModuleGatewayShutdownFrame;

export type ModuleGatewayCloseCode =
  | "requested"
  | "transport-closed"
  | "protocol-error";

export type ModuleGatewayFailureCode =
  | "invalid-frame"
  | "incompatible-protocol"
  | "duplicate-request"
  | "capacity-exceeded"
  | "unauthorized"
  | "unknown-alias"
  | "unknown-capability"
  | "stale-runtime"
  | "invalid-input"
  | "provider-failure"
  | "invalid-output"
  | "cancelled"
  | "timeout"
  | "transport-closed";

export class ModuleGatewayError extends Error {
  readonly code: ModuleGatewayFailureCode;

  constructor(
    code: ModuleGatewayFailureCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.name = "ModuleGatewayError";
  }
}

export interface ModuleGatewayClose {
  readonly code: ModuleGatewayCloseCode;
  readonly reason: string;
}

export interface ModuleGatewaySession {
  close(reason: string): Promise<void>;
  readonly closed: Promise<ModuleGatewayClose>;
  readonly mode: ModuleGatewaySessionMode;
  publishCatalogChange(revision: string): Promise<void>;
}

export interface ModuleGateway {
  connect(input: {
    readonly runtime: ModuleRuntimeIdentity;
    readonly capabilities: readonly ModuleCapabilityRequest[];
    readonly transport: ModuleTransport;
  }): Promise<ModuleGatewaySession>;
  connectDevelopment(input: {
    readonly developmentId: string;
    readonly catalog: ModuleCapabilityCatalog;
    readonly transport: ModuleTransport;
  }): Promise<ModuleGatewaySession>;
}

export type ModuleCapabilityMode = "unary" | "stream";

export interface ModuleCapabilitySchema<Value> {
  readonly description: PortableSchema;
  parse(input: unknown): Value;
}

interface ModuleCapabilityDescriptorBase {
  readonly capability: string;
  readonly documentation: string;
  readonly input: PortableSchema;
  readonly version: number;
}

export interface ModuleUnaryCapabilityDescriptor
  extends ModuleCapabilityDescriptorBase {
  readonly mode: "unary";
  readonly output: PortableSchema;
}

export interface ModuleStreamCapabilityDescriptor
  extends ModuleCapabilityDescriptorBase {
  readonly event: PortableSchema;
  readonly mode: "stream";
}

export type ModuleCapabilityDescriptor =
  | ModuleUnaryCapabilityDescriptor
  | ModuleStreamCapabilityDescriptor;

export interface ModuleCapabilityInvocationContext {
  readonly constraints: unknown;
  readonly invocationId: string;
  readonly principal: ModulePrincipal;
  readonly signal: AbortSignal;
}

export interface ModuleUnaryCapabilityRegistration<Input, Output> {
  readonly descriptor: Omit<ModuleUnaryCapabilityDescriptor, "mode">;
  readonly input: ModuleCapabilitySchema<Input>;
  invoke(
    input: Input,
    context: ModuleCapabilityInvocationContext
  ): Promise<Output>;
  readonly mode: "unary";
  readonly output: ModuleCapabilitySchema<Output>;
}

export interface ModuleStreamCapabilityRegistration<Input, Event> {
  readonly descriptor: Omit<ModuleStreamCapabilityDescriptor, "mode">;
  readonly event: ModuleCapabilitySchema<Event>;
  readonly input: ModuleCapabilitySchema<Input>;
  invoke(
    input: Input,
    context: ModuleCapabilityInvocationContext
  ): AsyncIterable<Event>;
  readonly mode: "stream";
}

export type ModuleCapabilityRegistration =
  | ModuleUnaryCapabilityRegistration<unknown, unknown>
  | ModuleStreamCapabilityRegistration<unknown, unknown>;

export interface ModuleCapabilityProvider {
  readonly registration: ModuleCapabilityRegistration;
  resolveConstraints(input: {
    readonly principal: ModuleConstraintsPrincipal;
    readonly releaseConstraints: unknown;
  }): Promise<{ readonly constraintsDigest: string }>;
}

export interface ModuleCapabilityCatalog {
  readonly capabilities: readonly ModuleCapabilityDescriptor[];
  readonly generation: number;
}

export type ModuleGatewayInvocationRecord = {
  readonly capability?: {
    readonly name: string;
    readonly version: number;
  };
  readonly invocationId: string;
  readonly mode: "stream" | "unary";
  readonly principal: ModulePrincipal;
  readonly startedAt: string;
} & (ModuleGatewayInvocationEnd | { readonly status: "running" });

export type ModuleGatewayInvocationEnd = { readonly endedAt: string } & (
  | { readonly status: "complete" }
  | {
      readonly status: "cancelled" | "denied" | "failed";
      readonly errorCode?: ModuleGatewayFailureCode;
    }
);

export interface ModuleGatewayRuntimeDispatcher {
  dispatch(input: {
    readonly runtime: ModuleRuntimeIdentity;
    readonly capabilities: readonly ModuleCapabilityRequest[];
    readonly request: ModuleGatewayInvocationFrame;
    readonly signal: AbortSignal;
  }): Promise<ModuleGatewayDispatchResult>;
  revoke(input: {
    readonly installationId: InstallationId;
    readonly capability: string;
    readonly reason: string;
  }): void;
}

export type ModuleGatewayDispatchResult =
  | { readonly mode: "unary"; readonly output: unknown }
  | { readonly mode: "stream"; readonly events: AsyncIterable<unknown> };
