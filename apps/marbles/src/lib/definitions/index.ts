import type { RetryPolicy } from "@foundry/workflows/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Context, SetupContext } from "~/lib/definitions/types";

export type StepFn<I, O> = (context: Context<I>) => O | Promise<O>;
export type SetupFn<I, O = unknown> = (
  context: SetupContext<I>
) => LockedNode<O> | Promise<LockedNode<O>>;

export interface LockedNode<O = unknown> {
  readonly __output?: O;
  readonly children: readonly (readonly [string, LockedNode])[];
  readonly definition: AnyDefinition;
  readonly kind: "node";
  readonly literal: Readonly<Record<string, unknown>>;
  readonly mode: "series" | "parallel";
  readonly parsed?: boolean;
}

export interface Shared {
  readonly description?: string;
  readonly input?: StandardSchemaV1;
  readonly name?: string;
  readonly nameHint?: string;
  readonly origin?: string;
}

export interface StepConfig {
  readonly retry?: RetryPolicy;
  readonly timeout?: number | string;
}

export interface StepRecord<I = never, O = unknown> extends Shared {
  readonly __output?: O;
  readonly config?: StepConfig;
  readonly fn: StepFn<I, unknown>;
  readonly kind: "step";
  readonly output?: StandardSchemaV1;
}

export interface WorkflowRecord<I = never> extends Shared {
  readonly kind: "workflow";
  readonly setup: SetupFn<I>;
}

export type AnyDefinition = StepRecord | WorkflowRecord;

export function quoteOrigin(origin: string | undefined): string {
  return origin === undefined ? "" : ` (${origin})`;
}

export type NamedDefinition = AnyDefinition & { readonly name: string };

export function isNamed(
  definition: AnyDefinition
): definition is NamedDefinition {
  return definition.name !== undefined;
}

export function isLockedNode(value: unknown): value is LockedNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "node"
  );
}

export function rootLock(
  definition: AnyDefinition,
  literal: Readonly<Record<string, unknown>>
): LockedNode {
  return {
    children: [],
    definition,
    kind: "node",
    literal,
    mode: "series",
    parsed: true,
  };
}
