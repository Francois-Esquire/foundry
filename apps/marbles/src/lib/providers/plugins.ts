import type {
  ModelKind,
  Provider,
  ProviderModelDefinition,
} from "@foundry/models";
import type { z } from "zod";
import type { CliHarness, CliHarnessDescriptor } from "~/lib/cli-harnesses";
import type { GuestDriver } from "~/lib/sandbox/drivers";

export type ProviderScope = "machine" | "workspace";

export interface ProviderWorkspace {
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly id: string;
  readonly root: string;
}

export interface ProviderSetup<S> {
  readonly defaults?: Partial<Record<ModelKind, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly id: string;
  readonly models: readonly ProviderModelDefinition[];
  readonly scope: ProviderScope;
  readonly settings: S;
  readonly workspace?: ProviderWorkspace;
}

export interface Execution {
  readonly bin?: string;
  readonly driver: GuestDriver;
  readonly env: Readonly<Record<string, string>>;
  readonly guest: CliHarnessDescriptor<CliHarness>;
  readonly harness: CliHarness;
}

export interface ProviderInstance {
  readonly execution?: Execution;
  readonly provider: Provider;
}

export interface ProviderPlugin<S = unknown> {
  readonly accountEnv?: readonly string[];
  readonly ambient?: true;
  readonly binding?: "workspace";
  catalog(settings: S): readonly ProviderModelDefinition[];
  create(setup: ProviderSetup<S>): ProviderInstance;
  detect?(context: {
    readonly env: Readonly<Record<string, string>>;
  }): S | null;
  readonly id: string;
  readonly label: string;
  list?(context: {
    readonly env: Readonly<Record<string, string>>;
    readonly settings: S;
    readonly signal: AbortSignal;
  }): Promise<readonly ProviderModelDefinition[]>;
  readonly secrets?: readonly string[];
  readonly settings: z.ZodType<S>;
}
