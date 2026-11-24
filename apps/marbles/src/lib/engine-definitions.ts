import type { BaseContext } from "@foundry/workflows/executable";
import type { Bindings } from "~/lib/bindings";
import type { AnyDefinition } from "~/lib/definition";
import type { Launcher } from "~/lib/launcher";
import type { QueuedWorkflows } from "~/lib/queued-workflows";
import type { MonitorRecord } from "~/lib/registry";
import { Registry } from "~/lib/registry";
import type { RunScopes } from "~/lib/run-scope";
import type { TaskDefinition } from "~/lib/tasks";
import { factoryFor } from "~/lib/tree";
import type { Factory } from "~/lib/workflow-queue";

export interface EngineDefinitionsOptions {
  readonly bindings: () => Bindings;
  readonly launcher: () => Pick<Launcher, "has" | "task">;
  readonly running: () => QueuedWorkflows | undefined;
  readonly scopes: RunScopes;
}

export class EngineDefinitions {
  readonly registry = new Registry();
  readonly #direct = new Map<string, AnyDefinition>();
  readonly #directNames = new WeakMap<AnyDefinition, string>();
  readonly #extra = new Map<string, (running: QueuedWorkflows) => void>();
  readonly #options: EngineDefinitionsOptions;

  constructor(options: EngineDefinitionsOptions) {
    this.#options = options;
  }

  define(definition: AnyDefinition): void {
    if (definition.name !== undefined) {
      this.#claim(definition.name, { definitions: false, label: "define" });
    }
    this.registry.define(definition);
    if (definition.name !== undefined) {
      this.#registerOnQueue(definition.name);
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
      running.register(name, this.#factory(definition));
    }
    for (const register of this.#extra.values()) {
      register(running);
    }
  }

  directName(definition: AnyDefinition, running: QueuedWorkflows): string {
    const known = this.#directNames.get(definition);
    if (known !== undefined) {
      return known;
    }
    const declared = definition.name;
    const registered =
      declared !== undefined &&
      this.registry.definitions.get(declared) === definition
        ? declared
        : undefined;
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
      running.register(name, this.#factory(definition));
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
