import { setTimeout as sleep } from "node:timers/promises";
import type { TaskContext } from "@foundry.sh/marbles/engine";
import { z } from "zod";

export interface WorkflowModels {
  route(): { readonly model: string; readonly provider: string };
}

interface WorkflowContext {
  readonly models: WorkflowModels;
  progress(value: Parameters<TaskContext["progress"]>[0]): void;
  readonly signal: AbortSignal;
  readonly task: TaskContext;
}

export interface RegisteredWorkflow<I = unknown, O = unknown> {
  readonly description: string;
  readonly id: string;
  readonly input: z.ZodType<I>;
  run(input: I, context: WorkflowContext): Promise<O>;
  readonly version: number;
}

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

  get(identity: string): RegisteredWorkflow | undefined {
    return this.#workflows.get(identity);
  }

  identities(): string[] {
    return [...this.#workflows.keys()];
  }
}

const tickerInput = z
  .object({
    count: z.number().int().min(1).max(100),
    intervalMs: z.number().int().min(0).max(60_000),
  })
  .strict();

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

const SUMMARY_MAX_CHARACTERS = 65_536;

const summarizeInput = z
  .object({ text: z.string().trim().min(1).max(SUMMARY_MAX_CHARACTERS) })
  .strict();

const SUMMARIZE_INSTRUCTIONS =
  "Summarize the text you are given in at most three short sentences. Reply with the summary only.";

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

export const WORKS_WORKFLOWS = new WorkflowRegistry([
  tickerWorkflow as RegisteredWorkflow,
  summarizeWorkflow as RegisteredWorkflow,
]);
