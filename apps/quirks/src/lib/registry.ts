import type { AgentSpec } from "@foundry/agents/agents/index";
import type {
  CompactionSettings,
  SessionHarness,
} from "@foundry/agents/harness";
import type { SessionStore } from "@foundry/agents/session";
import type { ModelManager, TurnExecutorRef } from "@foundry/models";
import type { DefinitionGraphBuilder } from "@foundry/workflows/definitions";
import type { Orchestrator } from "@foundry/workflows/orchestrator";
import { Step } from "@foundry/workflows/step";
import { Workflow } from "@foundry/workflows/workflow";
import type { directory, WorkspaceSystem } from "@foundry/workspaces";
import type { Git, git } from "@foundry/workspaces/git";

import type { MonitorInput, MonitorSpec } from "~/monitor";

/**
 * The registry the factories write into. One per process, populated by
 * importing a config module; the CLI binds primitives afterwards, once it
 * knows whether this is a dry run and which harnesses are on the machine.
 */

export interface SessionOptions {
  /**
   * On by default, summarizing with the turn model. `false` turns it off;
   * a partial object overrides individual settings (e.g. `keepTokens`).
   */
  readonly compaction?: false | Partial<CompactionSettings>;
  /** Confines every turn's CLI harness to this directory. */
  readonly cwd?: string;
  /** Defaults to the first executor. */
  readonly executor?: TurnExecutorRef;
  /** Adopt this session across runs; generated on first turn when omitted. */
  readonly sessionId?: string;
}

/** The system as Quirks composes it: `add({ path })`, and `git` on any working tree. */
export type QuirksWorkspaceSystem = WorkspaceSystem<
  [ReturnType<typeof directory>, ReturnType<typeof git>]
>;

/** What a step body receives, bound by the CLI after config import. */
export interface Primitives {
  readonly agents: {
    /** A `SessionHarness` for a registered agent, over `sessions`. */
    session(
      agent: AgentSpec,
      options?: SessionOptions
    ): Promise<SessionHarness>;
  };
  /** Harnesses on this machine, in preference order. Never empty. */
  readonly executors: readonly TurnExecutorRef[];
  readonly log: (line: string) => void;
  readonly models: ModelManager;
  /** Where every session's messages live. In memory today; the seam a durable store slots behind. */
  readonly sessions: SessionStore;
  /** The workspace state dir; `undefined` under `--dry`, when nothing persists. */
  readonly state?: string;
  /** The config's directory (or the cwd without one): what a files monitor watches by default. */
  readonly workspace: { readonly root: string };
  readonly workspaces: {
    readonly system: QuirksWorkspaceSystem;
    /** `Git` at a root; under `--dry` every mutation is echoed instead of run. */
    readonly git: (root: string) => Git;
  };
}

export type StepBody<I, O> = (primitives: Primitives, input: I) => Promise<O>;

export type WorkflowBody<I, O> = (graph: DefinitionGraphBuilder<I, O>) => void;

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

/** A wall-clock slot in machine-local time; no `weekday` means every day. */
export interface CalendarSlot {
  readonly hour: number;
  /** Defaults to 0. */
  readonly minute?: number;
  readonly weekday?: Weekday | readonly Weekday[];
}

export type Trigger =
  | { readonly kind: "interval"; readonly ms: number }
  | { readonly kind: "calendar"; readonly slot: CalendarSlot };

export interface Schedule {
  readonly input: unknown;
  /** Set when `monitor()` registered it; the step is a change detector. */
  readonly kind?: "monitor";
  readonly name: string;
  readonly trigger: Trigger;
  readonly workflow: string;
}

/**
 * A registered step is the Step itself. Its body runs against whatever
 * primitives are bound at execution time, which is what lets the config
 * register at import and the CLI decide `--dry` later.
 */
class RegisteredStep<I, O> extends Step<I, O> {
  readonly definitionKey: string;
  declare readonly name: string;
  readonly #body: StepBody<I, O>;

  constructor(name: string, body: StepBody<I, O>) {
    super();
    this.definitionKey = `quirks.${name}`;
    this.name = name;
    this.#body = body;
  }

  protected execute(input: I): Promise<O> {
    return this.#body(registry.primitives(), input);
  }
}

class RegisteredWorkflow<I, O> extends Workflow<I, O> {
  override readonly definitionKey: string;
  declare readonly name: string;
  readonly #body: WorkflowBody<I, O>;

  constructor(name: string, body: WorkflowBody<I, O>) {
    super();
    this.definitionKey = `quirks.${name}`;
    this.name = name;
    this.#body = body;
  }

  protected define(graph: DefinitionGraphBuilder<I, O>): void {
    this.#body(graph);
  }
}

/**
 * Step and Workflow are invariant in their type parameters, so the registry
 * holds a closure that registers each one rather than the definition itself.
 */
export type Register = (orchestrator: Orchestrator) => void;

class Registry {
  readonly definitions = new Map<string, Register>();
  readonly schedules = new Map<string, Schedule>();
  readonly agents = new Map<string, AgentSpec>();
  /** Keyed like the step and schedule a monitor registers under the same name. */
  readonly monitors = new Map<string, MonitorSpec>();
  #primitives: Primitives | undefined;

  agent(spec: AgentSpec): AgentSpec {
    if (this.agents.has(spec.id)) {
      throw new Error(`quirks: agent "${spec.id}" already registered`);
    }
    this.agents.set(spec.id, spec);
    return spec;
  }

  step<I, O>(name: string, body: StepBody<I, O>): Step<I, O> {
    const step = new RegisteredStep(name, body);
    this.#add(name, (orchestrator) => {
      orchestrator.register(name, step.factory());
    });
    return step;
  }

  workflow<I, O>(name: string, body: WorkflowBody<I, O>): Workflow<I, O> {
    const workflow = new RegisteredWorkflow(name, body);
    this.#add(name, (orchestrator) => {
      orchestrator.register(name, workflow.factory());
    });
    return workflow;
  }

  schedule(schedule: Schedule): void {
    if (this.schedules.has(schedule.name)) {
      throw new Error(`quirks: schedule "${schedule.name}" already registered`);
    }
    this.schedules.set(schedule.name, schedule);
  }

  /** One step (the detector) and one schedule, both named `name`. */
  monitor(
    name: string,
    spec: MonitorSpec,
    body: StepBody<MonitorInput, unknown>,
    trigger: Trigger
  ): void {
    if (this.definitions.has(name) || this.schedules.has(name)) {
      throw new Error(`quirks: "${name}" already registered`);
    }
    this.step(name, body);
    this.schedule({
      input: null,
      kind: "monitor",
      name,
      trigger,
      workflow: name,
    });
    this.monitors.set(name, spec);
  }

  bind(primitives: Primitives): void {
    this.#primitives = primitives;
  }

  primitives(): Primitives {
    if (!this.#primitives) {
      throw new Error("quirks: primitives are not bound; the CLI binds them");
    }
    return this.#primitives;
  }

  /** Tests only: forget everything a previous config registered. */
  reset(): void {
    this.definitions.clear();
    this.schedules.clear();
    this.agents.clear();
    this.monitors.clear();
    this.#primitives = undefined;
  }

  #add(name: string, register: Register): void {
    if (this.definitions.has(name)) {
      throw new Error(`quirks: "${name}" already registered`);
    }
    this.definitions.set(name, register);
  }
}

export const registry = new Registry();
