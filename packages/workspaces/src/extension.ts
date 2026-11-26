import type { WorkspaceRegistration } from "./schema";
import type { WorkspaceSourceAdapter } from "./source-adapter";
import type { Workspace } from "./workspace";

export type WorkspaceIdentity = Pick<WorkspaceRegistration, "name" | "source">;

export interface WorkspaceAttachContext {
  readonly capabilities: Readonly<Record<PropertyKey, unknown>>;
  readonly registration: WorkspaceRegistration;
}

export interface WorkspaceLifecycle {
  start?(workspace: Workspace): Promise<void> | void;
  stop?(workspace: Workspace): Promise<void> | void;
}

type HasRequiredKeys<T> = Record<never, never> extends T ? false : true;

export type WorkspaceAttachment<Capabilities extends object = object> =
  WorkspaceLifecycle &
    (HasRequiredKeys<Capabilities> extends true
      ? { readonly capabilities: Capabilities }
      : { readonly capabilities?: Capabilities });

type ExtensionAttach<Capabilities extends object> =
  HasRequiredKeys<Capabilities> extends true
    ? {
        attach(
          context: WorkspaceAttachContext
        ):
          | Promise<WorkspaceAttachment<Capabilities>>
          | WorkspaceAttachment<Capabilities>;
      }
    : {
        attach?(
          context: WorkspaceAttachContext
        ):
          | Promise<WorkspaceAttachment<Capabilities> | undefined>
          | WorkspaceAttachment<Capabilities>
          | undefined;
      };

export type WorkspaceExtension<
  Ref extends object = never,
  SourceCapabilities = unknown,
  Capabilities = unknown,
  Always extends boolean = boolean,
> = {
  applies: (
    registration: WorkspaceRegistration
  ) => [Always] extends [true]
    ? Promise<true> | true
    : Promise<boolean> | boolean;
  identify?(ref: Ref): Promise<WorkspaceIdentity> | WorkspaceIdentity;
  readonly name: string;
  readonly ref?: string;
  source?(registration: WorkspaceRegistration): WorkspaceSourceAdapter;
  readonly types?: {
    readonly capabilities: Capabilities;
    readonly source: SourceCapabilities;
  };
} & ExtensionAttach<SourceCapabilities & Capabilities & object>;

export interface AnyWorkspaceExtension {
  applies: (registration: WorkspaceRegistration) => Promise<boolean> | boolean;
  attach?(
    context: WorkspaceAttachContext
  ):
    | Promise<WorkspaceAttachment<object> | undefined>
    | WorkspaceAttachment<object>
    | undefined;
  identify?(ref: object): Promise<WorkspaceIdentity> | WorkspaceIdentity;
  readonly name: string;
  readonly ref?: string;
  source?(registration: WorkspaceRegistration): WorkspaceSourceAdapter;
  readonly types?: { readonly capabilities: unknown; readonly source: unknown };
}

export type RefOf<Extensions extends readonly AnyWorkspaceExtension[]> =
  Extensions[number] extends infer E
    ? E extends WorkspaceExtension<infer R>
      ? R
      : never
    : never;

export type SourceCapabilitiesFor<
  Extensions extends readonly AnyWorkspaceExtension[],
  R,
> = OrUnknown<
  Extensions[number] extends infer E
    ? E extends WorkspaceExtension<
        infer Ref,
        infer SourceCapabilities,
        infer _Capabilities
      >
      ? R extends Ref
        ? unknown extends SourceCapabilities
          ? never
          : SourceCapabilities
        : never
      : never
    : never
>;

export type CapabilitiesOf<
  Extensions extends readonly AnyWorkspaceExtension[],
> = Unboxed<
  UnionToIntersection<
    | {
        readonly [K in keyof Extensions]: {
          readonly capabilities: ExtensionCapabilities<Extensions[K]>;
        };
      }[number]
    | { readonly capabilities: unknown }
  >
>;

type Unboxed<Box> = Box extends { readonly capabilities: infer Capabilities }
  ? Capabilities
  : unknown;

type UnionToIntersection<U> = (
  U extends unknown
    ? (member: U) => void
    : never
) extends (member: infer I) => void
  ? I
  : never;

type ExtensionCapabilities<E> =
  E extends WorkspaceExtension<never, unknown, infer Capabilities>
    ? unknown extends Capabilities
      ? unknown
      : AppliesAlways<E> extends true
        ? Capabilities
        : DistributivePartial<Capabilities>
    : unknown;

type AppliesAlways<E> = E extends {
  readonly applies: (registration: WorkspaceRegistration) => infer Applied;
}
  ? false extends Awaited<Applied>
    ? false
    : true
  : false;

type DistributivePartial<T> = T extends unknown ? Partial<T> : never;

type OrUnknown<T> = [T] extends [never] ? unknown : T;
