import type { BaseContext } from "@foundry/workflows/executable";
import type { AnyDefinition } from "~/lib/definitions";
import type { Bindings } from "~/lib/definitions/bindings";
import type {
  DefinitionRegistration,
  MonitorRecord,
} from "~/lib/definitions/registry";
import { Registry } from "~/lib/definitions/registry";
import type { Launcher } from "~/lib/runs";
import type { Factory } from "~/lib/runs/queue";
import type { QueuedWorkflows } from "~/lib/runs/queued";
import type { RunScopes } from "~/lib/runs/scope";
import type { TaskDefinition } from "~/lib/runs/tasks";
import { factoryFor } from "~/lib/runs/tree";

export interface EngineDefinitionsOptions {
  readonly bindings: () => Bindings;
  readonly launcher: () => Pick<Launcher, "has" | "task">;
  readonly running: () => QueuedWorkflows | undefined;
  readonly scopes: RunScopes;
}

export class EngineDefinitions {
  readonly registry = new Registry();
  readonly #declaredNames = new WeakMap<AnyDefinition, string | null>();
  readonly #pools = new Map<string, string>();
  readonly #direct = new Map<string, AnyDefinition>();
  readonly #directNames = new WeakMap<AnyDefinition, string>();
  readonly #extra = new Map<string, (running: QueuedWorkflows) => void>();
  readonly #options: EngineDefinitionsOptions;

  constructor(options: EngineDefinitionsOptions) {
    this.#options = options;
  }

  define(
    definition: AnyDefinition,
    pool?: string,
    registration?: DefinitionRegistration
  ): void {
    const name = registration?.name ?? definition.name;
    if (name !== undefined) {
      this.#claim(name, { definitions: false, label: "define" });
    }
    this.registry.define(definition, registration);
    if (name !== undefined) {
      if (pool === undefined) {
        this.#pools.delete(name);
      } else {
        this.#pools.set(name, pool);
      }
      this.#registerOnQueue(name);
      const previous = this.#declaredNames.get(definition);
      this.#declaredNames.set(
        definition,
        previous === undefined || previous === name ? name : null
      );
    }
  }

  monitor(record: MonitorRecord): void {
    this.#claim(record.key, { definitions: false, label: "monitor" });
    this.registry.monitor(record);
    this.#registerOnQueue(record.key);
  }

  register<I, O, X extends BaseContext = BaseContext>(
    name: string,
    factory: Factory<I, O, X>
  ): void {
    this.#claim(name, { definitions: true, label: "register" });
    this.#extra.set(name, (running) =>
      running.register(name, (input) => factory(input as I))
    );
  }

  task<I, O>(definition: TaskDefinition<I, O>): void {
    this.#claim(definition.name, { definitions: true, label: "task" });
    this.#options.launcher().task(definition as TaskDefinition);
  }

  registered(name: string): boolean {
    return this.registry.definitions.has(name) || this.#extra.has(name);
  }

  nameOf(name: string): string {
    return this.#direct.get(name)?.name ?? name;
  }

  registerAll(running: QueuedWorkflows): void {
    for (const [name, definition] of this.registry.definitions) {
      running.register(name, this.#factory(definition, name));
    }
    for (const register of this.#extra.values()) {
      register(running);
    }
  }

  poolOf(name: string): string | undefined {
    return this.#pools.get(name);
  }

  declaredName(definition: AnyDefinition): string | undefined {
    const mapped = this.#declaredNames.get(definition);
    if (mapped !== undefined) {
      return mapped === null ? undefined : mapped;
    }
    if (
      definition.name !== undefined &&
      this.registry.definitions.get(definition.name) === definition
    ) {
      return definition.name;
    }
    return undefined;
  }

  directName(definition: AnyDefinition, running: QueuedWorkflows): string {
    const known = this.#directNames.get(definition);
    if (known !== undefined) {
      return known;
    }
    const registered = this.declaredName(definition);
    const name = registered ?? `direct-${crypto.randomUUID()}`;
    if (registered === undefined) {
      const register = (target: QueuedWorkflows) =>
        target.register(name, this.#factory(definition, name));
      this.#extra.set(name, register);
      register(running);
      this.#direct.set(name, definition);
    }
    this.#directNames.set(definition, name);
    return name;
  }

  #factory(definition: AnyDefinition, name?: string) {
    const { bindings, scopes } = this.#options;
    return name === undefined
      ? factoryFor(definition, bindings, scopes)
      : factoryFor(definition, bindings, scopes, name);
  }

  #registerOnQueue(name: string): void {
    const definition = this.registry.definitions.get(name);
    const running = this.#options.running();
    if (definition && running) {
      running.register(name, this.#factory(definition, name));
    }
  }

  #claim(
    name: string,
    claim: { readonly definitions: boolean; readonly label: string }
  ): void {
    if (
      this.#options.launcher().has(name) ||
      this.#extra.has(name) ||
      (claim.definitions && this.registry.definitions.has(name))
    ) {
      throw new Error(`${claim.label}("${name}"): already registered`);
    }
  }
}
