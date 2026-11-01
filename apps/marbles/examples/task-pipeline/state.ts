import type { Task } from "@foundry.sh/marbles";
import { z } from "zod";

/**
 * What the task pipeline keeps on a task: one JSON value under
 * `metadata.pipeline`. Everything here is pure; `pipeline.ts` reads and
 * writes it through the workspace's `tasks`.
 *
 * Only two stages ask the pipeline to act: `intake` (refine it) and
 * `prepared` (route it once `ready()` offers it). Every other stage is the
 * pipeline's own progress or a result, and the observer ignores it, so its
 * own writes never dispatch anything. A task with no state is not in the
 * pipeline: the observer enrolls it at `intake` only when a change gives it
 * the tag, and a user's `refine` request enrolls it again on purpose.
 */

export const METADATA_KEY = "pipeline";

export const STAGES = [
  "intake",
  "refining",
  "needs-clarification",
  "prepared",
  "routing",
  "running",
  "awaiting-acceptance",
  "accepted",
  "failed",
  "unsupported",
  "blocked",
  "interrupted",
] as const;
export type Stage = (typeof STAGES)[number];

/** Stages with an attempt in flight, owned by one pipeline instance. */
const IN_FLIGHT: readonly Stage[] = ["refining", "routing", "running"];

/** Results `retry` and `reroute` start again from. */
const RETRYABLE: readonly Stage[] = [
  "failed",
  "unsupported",
  "blocked",
  "interrupted",
];

const json = z.json();

const attemptSchema = z.object({
  claimedAt: z.string(),
  id: z.string(),
  kind: z.enum(["refine", "route"]),
  number: z.number().int().min(1),
  /** The pipeline instance that claimed it; one per host process. */
  owner: z.string(),
  /**
   * When its run parked: on a question, or its step was paused. The engine
   * keeps a parked run and the next host adopts it, so reconcile leaves it
   * alone; the run clears this when it resumes.
   */
  parked: z.string().optional(),
  runId: z.string().optional(),
});
export type Attempt = z.output<typeof attemptSchema>;

const unknownSchema = z.object({
  assumption: z.string(),
  consequential: z.boolean(),
  question: z.string(),
});

export const refinementSchema = z.object({
  acceptance: z.array(z.string()),
  constraints: z.array(z.string()),
  promoted: z.boolean(),
  provider: z.string().optional(),
  ready: z.boolean(),
  /** Why it was or was not promoted, in the pipeline's words. */
  reason: z.string(),
  requirements: z.array(z.string()),
  session: z.string().optional(),
  summary: z.string(),
  unknowns: z.array(unknownSchema),
});
export type Refinement = z.output<typeof refinementSchema>;

/** A route the pipeline will use: who chose it, and why. */
const routeSchema = z.object({
  input: z.record(z.string(), json),
  model: z.string().optional(),
  provider: z.string().optional(),
  reason: z.string(),
  session: z.string().optional(),
  source: z.enum(["model", "retry", "user"]),
  workflow: z.string(),
});
export type Route = z.output<typeof routeSchema>;

/** A route the next attempt must use instead of asking the router. */
const pinSchema = routeSchema.pick({
  input: true,
  reason: true,
  source: true,
  workflow: true,
});
export type Pin = z.output<typeof pinSchema>;

const outcomeSchema = z.object({
  at: z.string(),
  output: z.string().optional(),
  reason: z.string().optional(),
  runId: z.string().optional(),
  stage: z.enum(STAGES),
});

const historySchema = z.object({
  at: z.string(),
  attempt: z.string().optional(),
  kind: z.enum(["refine", "route", "request"]),
  reason: z.string().optional(),
  runId: z.string().optional(),
  stage: z.enum(STAGES),
  workflow: z.string().optional(),
});

export const pipelineStateSchema = z.object({
  attempt: attemptSchema.optional(),
  attempts: z.number().int().min(0).default(0),
  history: z.array(historySchema).default([]),
  outcome: outcomeSchema.optional(),
  pin: pinSchema.optional(),
  questions: z.array(z.string()).default([]),
  refinement: refinementSchema.optional(),
  route: routeSchema.optional(),
  stage: z.enum(STAGES),
});
export type PipelineState = z.output<typeof pipelineStateSchema>;

/** A task entering the pipeline, by the tag or by a `refine` request. */
export function enrolled(now: string, reason: string): PipelineState {
  return {
    attempts: 0,
    history: [{ at: now, kind: "request", reason, stage: "intake" }],
    questions: [],
    stage: "intake",
  };
}

/**
 * The task's pipeline state, or `undefined` when it has none the pipeline
 * can read: never enrolled, or replaced by a write that dropped it. The
 * observer never takes a missing state for a new task.
 */
export function stateOf(task: Task): PipelineState | undefined {
  const parsed = pipelineStateSchema.safeParse(task.metadata[METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

export function isInFlight(stage: Stage): boolean {
  return IN_FLIGHT.includes(stage);
}

/** Claim the next attempt of `kind` for `owner`. */
export function claim(
  state: PipelineState,
  kind: Attempt["kind"],
  owner: string,
  id: string,
  now: string
): PipelineState {
  const number = state.attempts + 1;
  return {
    ...state,
    attempt: { claimedAt: now, id, kind, number, owner },
    attempts: number,
    stage: kind === "refine" ? "refining" : "routing",
  };
}

/** The attempt's run parked; the attempt stays in flight. */
export function park(state: PipelineState, now: string): PipelineState {
  return state.attempt === undefined
    ? state
    : { ...state, attempt: { ...state.attempt, parked: now } };
}

/** Whether `state` holds the attempt `id` of `kind`, still undecided. */
export function holds(
  state: PipelineState,
  id: string,
  kind: Attempt["kind"]
): boolean {
  return (
    state.attempt?.id === id &&
    state.attempt.kind === kind &&
    (isInFlight(state.stage) || state.stage === "interrupted")
  );
}

const settlementSchema = z.object({
  output: z.string().optional(),
  questions: z.array(z.string()).optional(),
  reason: z.string().optional(),
  refinement: refinementSchema.optional(),
});
export type Settlement = z.output<typeof settlementSchema>;

/** End the current attempt with `stage`, keeping it in the history. */
export function settle(
  state: PipelineState,
  stage: Stage,
  settlement: Settlement,
  now: string
): PipelineState {
  const { attempt } = state;
  const { output, questions, reason, refinement } = settlement;
  const runId = attempt?.runId;
  const { attempt: _ended, ...rest } = state;
  return {
    ...rest,
    history: [
      ...state.history,
      {
        at: now,
        kind: attempt?.kind ?? "request",
        stage,
        ...(attempt === undefined ? {} : { attempt: attempt.id }),
        ...(reason === undefined ? {} : { reason }),
        ...(runId === undefined ? {} : { runId }),
        ...(stage !== "needs-clarification" && state.route
          ? { workflow: state.route.workflow }
          : {}),
      },
    ],
    outcome: {
      at: now,
      stage,
      ...(output === undefined ? {} : { output }),
      ...(reason === undefined ? {} : { reason }),
      ...(runId === undefined ? {} : { runId }),
    },
    questions: [...(questions ?? [])],
    stage,
    ...(refinement === undefined ? {} : { refinement }),
  };
}

/**
 * Mark an in-flight attempt whose owner is gone. Its outcome is unknown,
 * so the attempt stays recorded: a run that later finishes after all can
 * still land its result, until a retry or reroute replaces it.
 */
export function interrupt(state: PipelineState, now: string): PipelineState {
  const reason =
    "The pipeline instance that claimed this attempt stopped before it finished; the outcome is unknown. Retry or reroute explicitly.";
  return {
    ...settle(state, "interrupted", { reason }, now),
    ...(state.attempt === undefined ? {} : { attempt: state.attempt }),
  };
}

// ── notes ────────────────────────────────────────────────────────────────

/**
 * What an attempt's run did while the task had no readable state: an update
 * replaced its metadata, and the observer has not yet put the state back.
 * The run leaves a note under the same key instead (not a state, so the task
 * still reads as having none), and the observer applies it to the state it
 * restores, only if that state still holds this attempt for this run.
 */
const noteSchema = z.object({
  at: z.string(),
  attempt: z.string(),
  kind: z.enum(["refine", "route"]),
  /** Park the attempt; otherwise `settle` ends it. */
  park: z.literal(true).optional(),
  runId: z.string().optional(),
  settle: settlementSchema
    .extend({
      stage: z.enum(STAGES),
      status: z.enum(["open", "active"]).optional(),
    })
    .optional(),
});
export type Note = z.output<typeof noteSchema>;

/**
 * What the observer still owes a task that has no state, recorded on the
 * task before the change that asked for it is acknowledged, so a host that
 * stops in between leaves it on disk. It is decided when the observer
 * reaches the task's current version: `image` is put back, `enroll` enrolls
 * the task, and with neither nothing is owed, though an offer older than
 * `from` still loses to it. Not a state: it gives no caller permission to
 * run anything.
 */
const pendingSchema = z.object({
  enroll: z.literal(true).optional(),
  /** `updatedAt` of the change it came from; only a later one replaces it. */
  from: z.string(),
  image: pipelineStateSchema.optional(),
});
export type Pending = z.output<typeof pendingSchema>;

const notesSchema = z.object({
  notes: z.array(noteSchema),
  pending: pendingSchema.optional(),
});
export type Notes = z.output<typeof notesSchema>;

/**
 * What a task with no state carries under the key: its runs' notes and
 * what the observer owes it. Empty when it holds a state or nothing. A
 * write that adds a note keeps the rest, so a note never drops a pending.
 */
export function stateless(task: Task | null): Notes {
  const parsed = notesSchema.safeParse(task?.metadata[METADATA_KEY]);
  return parsed.success ? parsed.data : { notes: [] };
}

/** The notes a task's metadata carries; none when it holds a state or nothing. */
export function notesOf(task: Task | null): Note[] {
  return stateless(task).notes;
}

/** What the observer owes a task with no state, if anything. */
export function pendingOf(task: Task | null): Pending | undefined {
  return stateless(task).pending;
}

/**
 * Apply the note meant for the attempt `state` holds, or `undefined` when
 * none is: a note for another attempt, or another run of it, is stale. An
 * ending wins over a park, which applies only while the attempt is in flight.
 */
export function land(
  state: PipelineState,
  notes: readonly Note[]
): { state: PipelineState; status?: "open" | "active" } | undefined {
  const runId = state.attempt?.runId;
  const mine = notes.filter(
    (note) =>
      holds(state, note.attempt, note.kind) &&
      (runId === undefined || note.runId === undefined || note.runId === runId)
  );
  const ending = mine.find((note) => note.settle !== undefined);
  if (ending?.settle !== undefined) {
    const { stage, status, ...settlement } = ending.settle;
    return {
      state: settle(state, stage, settlement, ending.at),
      ...(status === undefined ? {} : { status }),
    };
  }
  const parked = mine.find((note) => note.park);
  return parked !== undefined && isInFlight(state.stage)
    ? { state: park(state, parked.at) }
    : undefined;
}

/** A user's request to move a task on, checked against where it is. */
export type Request =
  | { readonly action: "abandon" }
  | { readonly action: "accept" }
  | { readonly action: "refine" }
  | { readonly action: "prepare" }
  | { readonly action: "retry" }
  | { readonly action: "reroute"; readonly pin?: Pin };

/**
 * Apply `request`, or throw why it does not apply.
 *
 * - `refine`: back to `intake`, after the task was clarified. On a task
 *   with no state the pipeline can read, it enrolls the task afresh.
 * - `prepare`: accept a refinement that asked for clarification as it is.
 * - `retry`: route again; after a failed, interrupted, or unaccepted run,
 *   with the same route.
 * - `reroute`: route again without the last route, or with `pin`.
 * - `accept`: the destination's result meets the task; it is `accepted`,
 *   and the pipeline completes the task.
 * - `abandon`: give up an attempt whose run is parked (on a question, or
 *   paused). The attempt is dropped, so that run does nothing if it is
 *   answered or resumed later.
 */
export function request(
  state: PipelineState | undefined,
  task: Task,
  change: Request,
  now: string
): PipelineState {
  if (task.status === "completed" || task.status === "cancelled") {
    throw new Error(
      `Task ${task.id} is ${task.status}; reopen it before asking the pipeline to act`
    );
  }
  if (state === undefined) {
    if (change.action !== "refine") {
      throw new Error(
        `Task ${task.id} has no pipeline state the pipeline can read; request refine to enroll it again`
      );
    }
    return enrolled(now, "refine");
  }
  refuseInFlight(state, task, change);
  const allowed = REQUESTS_FROM[change.action];
  if (change.action !== "abandon" && !allowed.includes(state.stage)) {
    throw new Error(
      `Task ${task.id} is ${state.stage}; ${change.action} applies from ${allowed.join(", ")}`
    );
  }
  const { attempt: _replaced, pin: _cleared, ...rest } = state;
  const pin = pinFor(state, change);
  const stage = TARGET[change.action];
  return {
    ...rest,
    history: [
      ...state.history,
      { at: now, kind: "request", reason: change.action, stage },
    ],
    questions: [],
    stage,
    ...(pin === undefined ? {} : { pin }),
  };
}

/**
 * An attempt in flight refuses every request but `abandon`, which applies
 * only to a parked one (on a question, or paused): a run the engine still
 * holds, and the one way to stop waiting for it. One that is not parked is
 * running, or its process is gone, which reconcile settles.
 */
function refuseInFlight(
  state: PipelineState,
  task: Task,
  change: Request
): void {
  const parked = state.attempt?.parked !== undefined;
  const inFlight = isInFlight(state.stage);
  if (change.action === "abandon") {
    if (!(inFlight && parked)) {
      throw new Error(
        `Task ${task.id} has no attempt parked on a question or paused; abandon applies only to one`
      );
    }
    return;
  }
  if (!inFlight) {
    return;
  }
  if (parked) {
    throw new Error(
      `Task ${task.id} has a ${state.stage} attempt whose run ${state.attempt?.runId ?? ""} is parked on a question or paused, and its run can still resume; answer or resume it, or request abandon`
    );
  }
  throw new Error(
    `Task ${task.id} has a ${state.stage} attempt in flight; wait for it, or reconcile if its process is gone`
  );
}

const TARGET: Readonly<Record<Request["action"], Stage>> = {
  abandon: "interrupted",
  accept: "accepted",
  prepare: "prepared",
  refine: "intake",
  reroute: "prepared",
  retry: "prepared",
};

const REQUESTS_FROM: Readonly<Record<Request["action"], readonly Stage[]>> = {
  abandon: [],
  accept: ["awaiting-acceptance"],
  prepare: ["needs-clarification"],
  refine: [
    "needs-clarification",
    "prepared",
    "awaiting-acceptance",
    ...RETRYABLE,
  ],
  reroute: [
    "needs-clarification",
    "prepared",
    "awaiting-acceptance",
    ...RETRYABLE,
  ],
  retry: ["awaiting-acceptance", ...RETRYABLE],
};

/** Results whose recorded route a `retry` runs again. */
const RERUN: readonly Stage[] = [
  "awaiting-acceptance",
  "failed",
  "interrupted",
];

function pinFor(state: PipelineState, change: Request): Pin | undefined {
  if (change.action === "reroute") {
    return change.pin;
  }
  const reran = RERUN.includes(state.stage);
  if (change.action !== "retry" || !reran || state.route === undefined) {
    return;
  }
  return {
    input: state.route.input,
    reason: `Retry of ${state.route.workflow}, as routed before: ${state.route.reason}`,
    source: "retry",
    workflow: state.route.workflow,
  };
}
