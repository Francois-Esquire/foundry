import type { AgentSpec } from "@foundry/agents/agents/index";
import type {
  CompactionSettings,
  SessionHarness,
} from "@foundry/agents/harness";
import type { SessionStore } from "@foundry/agents/session";
import type { ModelManager, TurnExecutorRef } from "@foundry/models";
import type { DefinitionGraphBuilder } from "@foundry/workflows/definitions";
import type { Orchestrator } from "@foundry/workflows/orchestrator";
import type { StepContext } from "@foundry/workflows/step";
import { Step } from "@foundry/workflows/step";
import { Workflow } from "@foundry/workflows/workflow";
import type { WorkspaceSystem } from "@foundry/workspaces";
import type { Git, git } from "@foundry/workspaces/git";
import type { directory } from "@foundry/workspaces/node";
import type { Feed } from "~/feed/entry";
import { askFeed, FEED_POST_EVENT, feedPayload } from "~/feed/entry";
import type { Log } from "~/lib/log";
import { createLog } from "~/lib/log";
import type { MonitorInput, MonitorSpec } from "~/monitor";
import type { DefinitionOptions } from "./inputs";

/**
 * The registry the factories write into. One per process, populated by
 * importing a config module; the CLI binds primitives afterwards, once it
 * knows whether this is a dry run and which harnesses are on the machine.
 */

export interface SessionOptions {
  /**
   * Off by default. `true` summarizes with the turn model; a partial object
   * turns it on and overrides individual settings (e.g. `keepTokens`).
   */
  readonly compaction?: boolean | Partial<CompactionSettings>;
  /** Sets the CLI harness working directory; not a security boundary. */
  readonly cwd?: string;
  /** Defaults to the first executor. */
  readonly executor?: TurnExecutorRef;
  /** Adopt this session across runs; generated on first turn when omitted. */
  readonly sessionId?: string;
}

type DirectoryCatalogue = WorkspaceSystem<
  [ReturnType<typeof directory>, ReturnType<typeof git>]
>;

/** Catalogue directories and operate on Git working trees. */
export interface Workspaces {
  readonly git: (root: string) => Git;
  readonly load: DirectoryCatalogue["load"];
  readonly on: DirectoryCatalogue["on"];
}

/**
 * Live output from a running step: strings stream as text, anything else as
 * JSON data. Subscribers see it as it is written; the step's return value is
 * still its result.
 */
export interface StepStream {
  /** Drain a stream or async iterable into this step's output. */
  pipe<T>(source: ReadableStream<T> | AsyncIterable<T>): Promise<void>;
  write(value: unknown): void;
}

/** What a step body receives, bound by the CLI after config import. */
export interface Primitives {
  readonly agents: {
    /** A `SessionHarness` for a registered agent, over `sessions`. */
    session(
      agent: AgentSpec,
      options?: SessionOptions
    ): Promise<SessionHarness>;
  };
  /** Detected harnesses in preference order; may be empty for deterministic work. */
  readonly executors: readonly TurnExecutorRef[];
  /**
   * Publish an article to the feed: a result or milestone worth reading on
   * its own. Entries are Artifacts in the shared store, attributed to this
   * workspace, run and step.
   */
  readonly feed: Feed;
  /** Log any values into this run's logs; `log.warn(...)` etc. pick a level. */
  readonly log: Log;
  readonly models: ModelManager;
  /** Session storage: disk-backed in the CLI, in memory under --dry. */
  readonly sessions: SessionStore;
  /** Aborted when this step is cancelled. Pass to cancellable work such as fetch. */
  readonly signal?: AbortSignal;
  /** The workspace state dir; `undefined` under `--dry`, when nothing persists. */
  readonly state?: string;
  /** This step's live output. Only valid inside a running step. */
  readonly stream: StepStream;
  /** The config's directory (or the cwd without one): what a files monitor watches by default. */
  readonly workspace: { readonly root: string };
  readonly workspaces: Workspaces;
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
    this.definitionKey = name;
    this.name = name;
    this.#body = body;
  }

  protected execute(input: I, context: StepContext<I, O>): Promise<O> {
    const primitives = registry.primitives();
    return this.#body(
      {
        ...primitives,
        feed: {
          ask: (question) => askFeed(context.suspend.bind(context), question),
          post: (entry) =>
            context.emit(
              FEED_POST_EVENT,
              feedPayload(entry, primitives.workspace.root)
            ),
        },
        log: createLog((level, message) => {
          context.step.log(level, message);
          primitives.log[level](message);
        }),
        signal: context.step.signal,
        stream: {
          pipe: (source) => context.pipe(source),
          write: (value) => context.write(value),
        },
      },
      input
    );
  }
}

class RegisteredWorkflow<I, O> extends Workflow<I, O> {
  override readonly definitionKey: string;
  declare readonly name: string;
  readonly #body: WorkflowBody<I, O>;

  constructor(name: string, body: WorkflowBody<I, O>) {
    super();
    this.definitionKey = name;
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
  readonly definitionOptions = new Map<string, DefinitionOptions>();
  readonly definitions = new Map<string, Register>();
  readonly definitionKinds = new Map<string, "step" | "workflow">();
  readonly schedules = new Map<string, Schedule>();
  readonly agents = new Map<string, AgentSpec>();
  /** Keyed like the step and schedule a monitor registers under the same name. */
  readonly monitors = new Map<string, MonitorSpec>();
  #primitives: Primitives | undefined;

  agent(spec: AgentSpec): AgentSpec {
    if (this.agents.has(spec.id)) {
      throw new Error(`agent "${spec.id}" already registered`);
    }
    this.agents.set(spec.id, spec);
    return spec;
  }

  step<I, O>(
    name: string,
    body: StepBody<I, O>,
    options?: DefinitionOptions
  ): Step<I, O> {
    const step = new RegisteredStep(name, body);
    this.#add(name, (orchestrator) => {
      orchestrator.register(name, step.factory());
    });
    this.definitionKinds.set(name, "step");
    if (options) {
      this.definitionOptions.set(name, options);
    }
    return step;
  }

  workflow<I, O>(
    name: string,
    body: WorkflowBody<I, O>,
    options?: DefinitionOptions
  ): Workflow<I, O> {
    const workflow = new RegisteredWorkflow(name, body);
    this.#add(name, (orchestrator) => {
      orchestrator.register(name, workflow.factory());
    });
    this.definitionKinds.set(name, "workflow");
    if (options) {
      this.definitionOptions.set(name, options);
    }
    return workflow;
  }

  schedule(schedule: Schedule): void {
    if (this.schedules.has(schedule.name)) {
      throw new Error(`schedule "${schedule.name}" already registered`);
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
      throw new Error(`"${name}" already registered`);
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
      throw new Error("primitives are not bound; the CLI binds them");
    }
    return this.#primitives;
  }

  /** Tests only: forget everything a previous config registered. */
  reset(): void {
    this.definitions.clear();
    this.definitionOptions.clear();
    this.definitionKinds.clear();
    this.schedules.clear();
    this.agents.clear();
    this.monitors.clear();
    this.#primitives = undefined;
  }

  #add(name: string, register: Register): void {
    if (this.definitions.has(name)) {
      throw new Error(`"${name}" already registered`);
    }
    this.definitions.set(name, register);
  }
}

export const registry = new Registry();
