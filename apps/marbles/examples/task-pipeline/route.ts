import { z } from "zod";
import type { Pin, Refinement, Route } from "./state";

/**
 * Where a prepared task can go, and how a routing decision is checked
 * against that list. The router model chooses among `Destination`s by name
 * and fills only the fields each one lets it choose; the task's own context
 * is added by the destination, never taken from model text.
 */

/** What a destination is told about the task it runs for. */
export interface TaskBrief {
  readonly description: string | null;
  readonly id: string;
  readonly refinement?: Refinement;
  /** The task as one specification: title, description, refinement. */
  readonly spec: string;
  readonly title: string;
}

/** Anything `step()` or `workflow()` built: it has a name and runs. */
export interface Launchable {
  readonly name?: string;
  run(input: never): Promise<unknown>;
}

export interface Destination<
  C extends z.ZodObject = z.ZodObject,
  D extends Launchable = Launchable,
> {
  /** The definition's input, from the task and the fields chosen. */
  build(brief: TaskBrief, chosen: z.output<C>): Parameters<D["run"]>[0];
  /** The fields the router may choose; unknown fields are refused. */
  readonly choose: C;
  readonly definition: D;
  /** What it does, for the router. */
  readonly description: string;
}

/** A destination with `build` typed from its `choose` schema. */
export function destination<C extends z.ZodObject, D extends Launchable>(
  value: Destination<C, D>
): Destination {
  return value as unknown as Destination;
}

export function destinationName(value: Destination): string {
  const { name } = value.definition;
  if (name === undefined || name.trim() === "") {
    throw new Error(
      "task pipeline: every destination needs a named step or workflow"
    );
  }
  return name;
}

/**
 * The router's reply. Flat, with every field required, so a strict
 * structured-output harness accepts it; `needs-clarification` comes first,
 * so the smallest reply (what `--dry-run` answers) dispatches nothing.
 */
export const decisionSchema = z.object({
  decision: z.enum(["needs-clarification", "route"]),
  inputJson: z
    .string()
    .describe(
      'The chosen workflow\'s input as a JSON object, "{}" when it needs none.'
    ),
  questions: z
    .array(z.string())
    .describe("What must be answered first, for needs-clarification."),
  reason: z.string().describe("Why this workflow, or why none fits yet."),
  workflow: z
    .string()
    .describe(
      'One listed workflow name exactly, or "" for needs-clarification.'
    ),
});
export type Decision = z.output<typeof decisionSchema>;

/** A checked decision: what the attempt does next. */
export type Checked =
  | {
      readonly kind: "route";
      readonly destination: Destination;
      readonly input: unknown;
      readonly route: Route;
    }
  | {
      readonly kind: "needs-clarification";
      readonly questions: string[];
      readonly reason: string;
    }
  | { readonly kind: "unsupported"; readonly reason: string };

/** Who made a decision, recorded with the route it produced. */
export interface DecisionSource {
  readonly model?: string;
  readonly provider?: string;
  readonly session?: string;
  readonly source: Route["source"];
}

/**
 * Check a decision against the destinations: a known name, input that is a
 * JSON object, and only the fields that destination lets the router choose.
 * Anything else is `unsupported`, with the reason, and runs nothing.
 */
export function check(
  decision: Decision,
  destinations: readonly Destination[],
  brief: TaskBrief,
  by: DecisionSource
): Checked {
  if (decision.decision === "needs-clarification") {
    return {
      kind: "needs-clarification",
      questions: decision.questions,
      reason: decision.reason,
    };
  }
  const target = destinations.find(
    (candidate) => destinationName(candidate) === decision.workflow
  );
  const names = destinations.map(destinationName).join(", ");
  if (target === undefined) {
    return {
      kind: "unsupported",
      reason: `The router chose "${decision.workflow}", which is not a destination (${names}). Its reason: ${decision.reason}`,
    };
  }
  const chosen = parseObject(decision.inputJson);
  if (typeof chosen === "string") {
    return {
      kind: "unsupported",
      reason: `Input for ${decision.workflow} ${chosen}`,
    };
  }
  const parsed = target.choose.strict().safeParse(chosen);
  if (!parsed.success) {
    return {
      kind: "unsupported",
      reason: `Input for ${decision.workflow} does not fit what the router may choose: ${z.prettifyError(parsed.error)}`,
    };
  }
  return {
    destination: target,
    input: target.build(brief, parsed.data),
    kind: "route",
    route: {
      input: chosen,
      reason: decision.reason,
      source: by.source,
      workflow: decision.workflow,
      ...(by.model === undefined ? {} : { model: by.model }),
      ...(by.provider === undefined ? {} : { provider: by.provider }),
      ...(by.session === undefined ? {} : { session: by.session }),
    },
  };
}

/** A pinned route as the decision it stands for. */
export function pinnedDecision(pin: Pin | Route): Decision {
  return {
    decision: "route",
    inputJson: JSON.stringify(pin.input),
    questions: [],
    reason: pin.reason,
    workflow: pin.workflow,
  };
}

type JsonObject = Record<string, z.output<ReturnType<typeof z.json>>>;

/** A JSON object, or why the text is not one. */
function parseObject(text: string): JsonObject | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "is not JSON.";
  }
  const object = z.record(z.string(), z.json()).safeParse(value);
  return object.success ? object.data : "is not a JSON object.";
}

/** The router's view of each destination: name, purpose, choosable input. */
export function describeDestinations(
  destinations: readonly Destination[]
): string {
  return destinations
    .map((target) =>
      [
        `- ${destinationName(target)}: ${target.description}`,
        `  input schema: ${JSON.stringify(z.toJSONSchema(target.choose.strict()))}`,
      ].join("\n")
    )
    .join("\n");
}

export const ROUTER_PROMPT = [
  "You choose how a prepared task is executed. The task's requirements are settled; decide only which workflow runs it.",
  "Choose exactly one listed workflow by its exact name, and give its input as a JSON object that matches that workflow's input schema. Leave out fields you have no reason to set.",
  "Answer needs-clarification, with the questions, when no listed workflow fits or when a choice the workflow needs is not determined by the task.",
  "Never invent workflow names, commands, fields, or file paths.",
].join("\n");

export function routePrompt(
  brief: TaskBrief,
  destinations: readonly Destination[]
): string {
  return [
    `Workflows:\n${describeDestinations(destinations)}`,
    `Task:\n${brief.spec}`,
  ].join("\n\n");
}
