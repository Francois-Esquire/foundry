import { setTimeout as sleep } from "node:timers/promises";
import type { TaskContext } from "@foundry.sh/marbles/engine";
import { z } from "zod";

/**
 * Host-registered workflows (spec §1, §7): Works registers each by ID and
 * version, and a Module may only start one of them with validated input. A
 * Module never submits a definition for the host to evaluate.
 */

/** Where a model call routes; credentials stay in the host's model manager. */
export interface WorkflowModels {
  route(): { readonly model: string; readonly provider: string };
}

interface WorkflowContext {
  /** Host model routing, resolved when the workflow runs. */
  readonly models: WorkflowModels;
  /** Record where the run has got to; the latest replaces the last. */
  progress(value: Parameters<TaskContext["progress"]>[0]): void;
  /** Aborted when the run is cancelled. */
  readonly signal: AbortSignal;
  /** The engine run: its agents record model turns on it. */
  readonly task: TaskContext;
}

export interface RegisteredWorkflow<I = unknown, O = unknown> {
  readonly description: string;
  readonly id: string;
  readonly input: z.ZodType<I>;
  /** The run's answer. It goes back to the Module that started it, never to the run store. */
  run(input: I, context: WorkflowContext): Promise<O>;
  readonly version: number;
}

/** The one spelling of a workflow's identity: `id@version`. */
export function workflowIdentity(id: string, version: number): string {
  return `${id}@${String(version)}`;
}

export class WorkflowRegistry {
  readonly #workflows = new Map<string, RegisteredWorkflow>();

  constructor(workflows: readonly RegisteredWorkflow[] = []) {
    for (const workflow of workflows) {
      this.register(workflow);
    }
  }

  register(workflow: RegisteredWorkflow): void {
    const identity = workflowIdentity(workflow.id, workflow.version);
    if (this.#workflows.has(identity)) {
      throw new Error(`Workflow ${identity} is registered more than once`);
    }
    this.#workflows.set(identity, workflow);
  }

  /** The workflow named `id@version`, if the host registered it. */
  get(identity: string): RegisteredWorkflow | undefined {
    return this.#workflows.get(identity);
  }

  /** Every registered `id@version`: the engine task names its runs carry. */
  identities(): string[] {
    return [...this.#workflows.keys()];
  }
}

// ── works.examples.ticker@1 ──

const tickerInput = z
  .object({
    count: z.number().int().min(1).max(100),
    intervalMs: z.number().int().min(0).max(60_000),
  })
  .strict();

/**
 * A deterministic workflow: `count` ticks, `intervalMs` apart, each one
 * recorded as progress. It calls nothing, so tests and smokes can start,
 * watch and cancel real engine runs without a model.
 */
const tickerWorkflow: RegisteredWorkflow<
  z.infer<typeof tickerInput>,
  { readonly ticks: number }
> = {
  description:
    "Counts `count` ticks, `intervalMs` apart, reporting each as progress.",
  id: "works.examples.ticker",
  input: tickerInput,
  async run({ count, intervalMs }, { progress, signal }) {
    for (let tick = 1; tick <= count; tick += 1) {
      await sleep(intervalMs, undefined, { signal });
      progress({ count, tick });
    }
    return { ticks: count };
  },
  version: 1,
};

// ── works.text.summarize@1 ──

/** The most text one summary takes, in UTF-16 code units. */
const SUMMARY_MAX_CHARACTERS = 65_536;

const summarizeInput = z
  .object({ text: z.string().trim().min(1).max(SUMMARY_MAX_CHARACTERS) })
  .strict();

const SUMMARIZE_INSTRUCTIONS =
  "Summarize the text you are given in at most three short sentences. Reply with the summary only.";

/**
 * A model call made on the host: the route and its credentials come from
 * Works' model manager when the run starts, so no key reaches the Module.
 * Model failures are reported without the provider's message, which the
 * run record would otherwise keep.
 */
const summarizeWorkflow: RegisteredWorkflow<
  z.infer<typeof summarizeInput>,
  { readonly summary: string }
> = {
  description: "Summarizes text with the host's model.",
  id: "works.text.summarize",
  input: summarizeInput,
  async run({ text }, { models, signal, task }) {
    let route: ReturnType<WorkflowModels["route"]>;
    try {
      route = models.route();
    } catch (error) {
      throw new Error(
        "No model is set up. Add a Gateway or Vercel API key in Settings.",
        { cause: error }
      );
    }
    try {
      const session = await task.agents.session({
        id: "works-summarize",
        kind: "agent",
        model: route.model,
        prompt: SUMMARIZE_INSTRUCTIONS,
        provider: route.provider,
      });
      const reply = await session.generate(text);
      return { summary: reply.text.trim() };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new Error("The model could not summarize the text", {
        cause: error,
      });
    }
  },
  version: 1,
};

/** Every workflow Works registers for Modules. */
export const WORKS_WORKFLOWS = new WorkflowRegistry([
  tickerWorkflow as RegisteredWorkflow,
  summarizeWorkflow as RegisteredWorkflow,
]);
