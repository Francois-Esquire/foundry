import { randomUUID } from "node:crypto";
import {
  type AgentRoute,
  type Agents,
  agent,
  Output,
  observe,
  type SkillSet,
  skills,
  step,
  type Task,
  type TaskDelta,
  TaskError,
  type TaskOperation,
  type TaskStatus,
  tasks,
} from "@foundry.sh/marbles";
import { z } from "zod";
import {
  briefOf,
  promotion,
  REFINER_PROMPT,
  refinementOf,
  refinementReplySchema,
  refinementSkill,
  refinePrompt,
} from "./refine";
import {
  type Checked,
  check,
  type Destination,
  decisionSchema,
  destinationName,
  pinnedDecision,
  ROUTER_PROMPT,
  routePrompt,
  type TaskBrief,
} from "./route";
import {
  type Attempt,
  claim,
  enrolled,
  holds,
  interrupt,
  isInFlight,
  land,
  METADATA_KEY,
  type Note,
  type Notes,
  notesOf,
  type Pending,
  type Pin,
  type PipelineState,
  park,
  pendingOf,
  type Request,
  request,
  type Settlement,
  type Stage,
  settle,
  stateless,
  stateOf,
} from "./state";

/**
 * Tasks as the entry point: a task given the pipeline's tag is refined,
 * prepared when the refinement meets the explicit rule, routed by a small
 * model to one of the destinations once `ready()` offers it, and run with
 * the task as its context. A run that returns waits for a user to accept
 * its result; only that completes the task. See `task-pipeline.md` for the
 * guarantees.
 */

export const ROUTER_MODEL_ENV = "MARBLES_PIPELINE_ROUTER_MODEL";

export interface ModelChoice extends AgentRoute {
  /** The skills its sessions get; chosen explicitly, never every skill. */
  readonly skills?: SkillSet;
}

export interface TaskPipelineOptions {
  readonly destinations: readonly Destination[];
  /** Prefix of its step and agent names. Default `task-pipeline`. */
  readonly name?: string;
  /** Route and skills for refinement; the engine's default route when omitted. */
  readonly refiner?: ModelChoice;
  /**
   * The routing model. `provider` defaults to `codex`; `model` defaults to
   * `MARBLES_PIPELINE_ROUTER_MODEL`, and with neither, routing is `blocked`.
   */
  readonly router?: ModelChoice;
  /** Only tasks with this tag enter the pipeline. Default `pipeline`. */
  readonly tag?: string;
  /** Limit for each refinement or routing turn. Default five minutes. */
  readonly turnTimeoutMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const MAX_WRITE_TRIES = 8;
const MAX_OUTPUT_CHARS = 2000;
const MODEL_ID = /^[\w.:/-]+$/;

const attemptInput = z.object({
  attemptId: z.string().min(1),
  taskId: z.string().min(1),
});
type AttemptInput = z.output<typeof attemptInput>;

const taskId = z.string().min(1);
const requestInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("abandon"), taskId }),
  z.object({ action: z.literal("accept"), taskId }),
  z.object({ action: z.literal("refine"), taskId }),
  z.object({ action: z.literal("prepare"), taskId }),
  z.object({ action: z.literal("retry"), taskId }),
  z.object({
    action: z.literal("reroute"),
    input: z.record(z.string(), z.json()).default({}),
    reason: z.string().default("Chosen by the user."),
    taskId,
    workflow: z
      .string()
      .min(1)
      .optional()
      .describe("A destination to use; the router decides when omitted."),
  }),
]);

/**
 * What a write does: the next state (or the notes a run leaves while the
 * task has none), and a status for an unsettled task. `requireReady` moves
 * the status only if the task is ready when the batch commits.
 */
interface Write {
  readonly requireReady?: boolean;
  readonly state: PipelineState | Notes;
  readonly status?: TaskStatus;
}

/** What an attempt does after deciding: run, or end with a stage. */
type Next = Checked | { readonly kind: "blocked"; readonly reason: string };

/** The read-modify-write every pipeline write goes through. */
type Transition = (
  task: Task,
  state: PipelineState | undefined
) => Write | undefined;

export function taskPipeline(options: TaskPipelineOptions) {
  const name = options.name ?? "task-pipeline";
  const tag = options.tag ?? "pipeline";
  const timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const { destinations } = options;
  requireDistinctNames(destinations);
  /** This instance: one per host process, so a foreign owner is a stopped one. */
  const owner = randomUUID();

  const refiner = agent({
    name: `${name}-refiner`,
    prompt: REFINER_PROMPT,
    skills: options.refiner?.skills ?? skills.none().add(refinementSkill),
    ...routeOf(options.refiner),
  });
  const router = agent({
    name: `${name}-router`,
    prompt: ROUTER_PROMPT,
    provider: options.router?.provider ?? "codex",
    ...(options.router?.skills === undefined
      ? {}
      : { skills: options.router.skills }),
  });

  // ── writes ─────────────────────────────────────────────────────────────

  /**
   * Read the task, decide the next write, and commit it only if the task
   * has not changed since it was read; on a conflict, decide again. Metadata
   * is replaced whole by an update, so the rest of it is carried over. A
   * settled task's status is never moved.
   *
   * Returns the task as the last try left it: as committed, or as read when
   * that try wrote nothing; `undefined` only when there is no task. Whatever
   * a caller goes on to do is decided from that task's state, never from
   * what an earlier try's transition thought it would write.
   */
  async function write(
    id: string,
    transition: Transition
  ): Promise<Task | undefined> {
    for (let tries = 0; tries < MAX_WRITE_TRIES; tries += 1) {
      const task = await tasks.get(id);
      if (task === null) {
        return;
      }
      const next = transition(task, stateOf(task));
      if (next === undefined) {
        return task;
      }
      try {
        const result = await tasks.change({
          operations: operations(task, next),
        });
        return result.tasks.find((item) => item.id === id);
      } catch (error) {
        if (!(error instanceof TaskError && error.code === "conflict")) {
          throw error;
        }
      }
    }
    throw new Error(
      `task pipeline: task ${id} kept changing; nothing was written`
    );
  }

  /** A write to a task in the pipeline; one without readable state is left alone. */
  function update(
    id: string,
    transition: (task: Task, state: PipelineState) => Write | undefined
  ): Promise<Task | undefined> {
    return write(id, (task, state) =>
      state === undefined ? undefined : transition(task, state)
    );
  }

  /** Whether the task still opts in to the pipeline. */
  function member(task: Task): boolean {
    return task.tags.includes(tag);
  }

  /**
   * A write by the run of attempt `input`. While an update has left the
   * task without readable state, the run cannot decide against it, so it
   * leaves `outcome` as a note for the observer, which applies it to the
   * state it restores if that still holds this attempt. The tag does not
   * matter here: it only decides what starts, and what a run did is
   * recorded either way. A note is not a state, so the task it leaves gives
   * no caller permission to run anything.
   */
  function own(
    input: AttemptInput,
    kind: Attempt["kind"],
    runId: string | undefined,
    outcome: Pick<Note, "park" | "settle">,
    transition: (task: Task, state: PipelineState) => Write | undefined
  ): Promise<Task | undefined> {
    return write(input.taskId, (task, state) => {
      if (state !== undefined) {
        return transition(task, state);
      }
      const note: Note = {
        at: now(),
        attempt: input.attemptId,
        kind,
        ...outcome,
        ...(runId === undefined ? {} : { runId }),
      };
      const kept = stateless(task);
      return { state: { ...kept, notes: [...kept.notes, note] } };
    });
  }

  /** End attempt `id` with `stage`, if it is still the task's attempt. */
  function end(
    input: AttemptInput,
    kind: Attempt["kind"],
    runId: string | undefined,
    stage: Stage,
    settlement: Settlement,
    status?: "open"
  ): Promise<Task | undefined> {
    return own(
      input,
      kind,
      runId,
      { settle: { ...settlement, stage, ...(status ? { status } : {}) } },
      (_task, state) =>
        holds(state, input.attemptId, kind)
          ? {
              state: settle(state, stage, settlement, now()),
              ...(status ? { status } : {}),
            }
          : undefined
    );
  }

  /**
   * Hand an attempt that has not started its destination back to the stage
   * it waited in, because the task lost the tag. Nothing ran; tagging it
   * again goes on from there.
   */
  function withdraw(state: PipelineState, kind: Attempt["kind"]): Write {
    return {
      state: settle(
        state,
        kind === "refine" ? "intake" : "prepared",
        {
          reason: `The task no longer has the tag "${tag}", so nothing ran; tag it again to go on.`,
        },
        now()
      ),
    };
  }

  /**
   * The run takes its attempt: records its run id, once. A replay of the
   * same run proceeds; one resuming from a park, possibly in a later
   * process, takes the attempt over for this instance. Any other run, or an
   * attempt already replaced, interrupted, or abandoned, does nothing. One
   * whose task lost the tag before its destination started is withdrawn.
   *
   * The run goes on only with the task `begun` accepts, as committed or as
   * read: a withdrawal, a note, or a state that moved on refuses it.
   */
  async function begin(
    input: AttemptInput,
    kind: Attempt["kind"],
    runId: string
  ): Promise<Task | undefined> {
    const begun = (task: Task): boolean => {
      const state = stateOf(task);
      const held = state?.attempt;
      return (
        state !== undefined &&
        held !== undefined &&
        holds(state, input.attemptId, kind) &&
        state.stage !== "interrupted" &&
        held.runId === runId &&
        held.owner === owner &&
        held.parked === undefined &&
        (member(task) || state.stage === "running")
      );
    };
    const taken = await own(
      input,
      kind,
      runId,
      {
        settle: {
          reason:
            "Its pipeline state was replaced as its run began, so the run did nothing more; retry or reroute explicitly.",
          stage: "failed",
          status: "open",
        },
      },
      (current, recorded) => {
        const held = recorded.attempt;
        if (
          begun(current) ||
          held === undefined ||
          recorded.stage === "interrupted" ||
          !holds(recorded, input.attemptId, kind) ||
          (held.runId !== undefined && held.runId !== runId)
        ) {
          return;
        }
        if (!member(current) && recorded.stage !== "running") {
          return withdraw(recorded, kind);
        }
        const { parked: _resumed, ...rest } = held;
        return { state: { ...recorded, attempt: { ...rest, owner, runId } } };
      }
    );
    return taken !== undefined && begun(taken) ? taken : undefined;
  }

  /**
   * What a step does with an error its work threw. Control flow is not a
   * result: it travels up unrecorded, so the engine can suspend, resume, or
   * cancel the run. The run parks when the step (or a child) asks a
   * question, or when the step itself is paused: its signal aborted while
   * its run's did not. That park is recorded first, so reconcile leaves the
   * attempt to the run the engine keeps. A cancelled or stopping run aborts
   * the run's signal too; it is not a park, and reconcile settles it.
   */
  async function passControl(
    input: AttemptInput,
    kind: Attempt["kind"],
    run: { readonly id: string; readonly signal: AbortSignal },
    signal: AbortSignal,
    error: unknown
  ): Promise<void> {
    const paused = signal.aborted && !run.signal.aborted;
    if (isSuspension(error) || paused) {
      try {
        await own(input, kind, run.id, { park: true }, (_task, state) =>
          holds(state, input.attemptId, kind) &&
          state.attempt?.runId === run.id &&
          isInFlight(state.stage)
            ? { state: park(state, now()) }
            : undefined
        );
      } catch {
        // A stopping host refuses writes; the run is kept as parked anyway,
        // and an attempt left unmarked is reconciled as interrupted.
      }
      throw error;
    }
    if (signal.aborted) {
      throw error;
    }
  }

  // ── refinement ─────────────────────────────────────────────────────────

  const refine = step(`${name}-refine`)
    .describe("Refine one pipeline task's attempt; the observer launches it.")
    .input(attemptInput)
    .do(async ({ agents, input, run, signal }) => {
      const task = await begin(input, "refine", run.id);
      if (task === undefined) {
        return { skipped: true, taskId: input.taskId };
      }
      try {
        const session = await agents.session(refiner);
        const reply = await session.generate(refinePrompt(task), {
          output: Output.object({ schema: refinementReplySchema }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const value = refinementReplySchema.parse(reply.output);
        const verdict = promotion(value);
        const stage = verdict.promoted ? "prepared" : "needs-clarification";
        await end(input, "refine", run.id, stage, {
          questions: verdict.questions,
          reason: verdict.reason,
          refinement: refinementOf(value, verdict, session.ref),
        });
        return { stage, taskId: task.id };
      } catch (error) {
        await passControl(input, "refine", run, signal, error);
        await end(input, "refine", run.id, "failed", {
          reason: `Refinement failed: ${message(error)}`,
        });
        return { stage: "failed", taskId: task.id };
      }
    });

  // ── routing and execution ──────────────────────────────────────────────

  async function decide(
    agents: Agents,
    brief: TaskBrief,
    state: PipelineState
  ): Promise<Next> {
    if (state.stage === "running" && state.route !== undefined) {
      // A replay of a run that already started: the route it recorded.
      return check(
        pinnedDecision(state.route),
        destinations,
        brief,
        state.route
      );
    }
    if (state.pin !== undefined) {
      return check(pinnedDecision(state.pin), destinations, brief, state.pin);
    }
    const model = routerModel(options.router?.model);
    if (typeof model !== "string") {
      return { kind: "blocked", reason: model.reason };
    }
    const session = await agents.session(router.extend({ model }));
    const reply = await session.generate(routePrompt(brief, destinations), {
      output: Output.object({ schema: decisionSchema }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return check(decisionSchema.parse(reply.output), destinations, brief, {
      model: session.ref.model ?? model,
      provider: session.ref.provider ?? router.provider,
      session: session.ref.id,
      source: "model",
    });
  }

  const attempt = step(`${name}-attempt`)
    .describe(
      "Route one prepared pipeline task and run it; the observer launches it."
    )
    .input(attemptInput)
    .do(async ({ agents, input, run, signal }) => {
      const task = await begin(input, "route", run.id);
      const state = task === undefined ? undefined : stateOf(task);
      if (task === undefined || state === undefined) {
        return { skipped: true, taskId: input.taskId };
      }
      let next: Next;
      try {
        next = await decide(agents, briefOf(task, state.refinement), state);
      } catch (error) {
        await passControl(input, "route", run, signal, error);
        await end(input, "route", run.id, "failed", {
          reason: `Routing failed: ${message(error)}`,
        });
        return { stage: "failed", taskId: task.id };
      }
      if (next.kind !== "route") {
        await end(input, "route", run.id, next.kind, {
          reason: next.reason,
          ...(next.kind === "needs-clarification"
            ? { questions: next.questions }
            : {}),
        });
        return { stage: next.kind, taskId: task.id };
      }
      const started = await start(input, run.id, next);
      if (started !== "running") {
        return { stage: started, taskId: task.id };
      }
      try {
        const output = await next.destination.definition.run(
          next.input as never
        );
        // Returning is not meeting the acceptance criteria: the task stays
        // active, holding its dependents back, until a user accepts it.
        await end(input, "route", run.id, "awaiting-acceptance", {
          output: preview(output),
        });
        return { runId: run.id, stage: "awaiting-acceptance", taskId: task.id };
      } catch (error) {
        await passControl(input, "route", run, signal, error);
        await end(
          input,
          "route",
          run.id,
          "failed",
          { reason: `${next.route.workflow} failed: ${message(error)}` },
          "open"
        );
        return { stage: "failed", taskId: task.id };
      }
    });

  /**
   * Record the route and mark the task running, in one batch whose start
   * the task store refuses unless the task is ready at commit. When
   * something holds it back (a dependency added since `ready()` offered it,
   * even one that left the task's token alone), it waits, `prepared`, for
   * the next time `ready()` offers it. Each try reads the task afresh, so a
   * task that lost the tag before the batch commits is withdrawn instead,
   * and its destination never starts.
   *
   * The destination may run only if the task this returns from shows this
   * run's attempt `running`: the start this run committed, or, on a replay,
   * the one it committed before. A note, a withdrawal, a refused start, or a
   * state that moved on all leave it not running, whatever an earlier try
   * decided.
   */
  async function start(
    input: AttemptInput,
    runId: string,
    next: Extract<Next, { kind: "route" }>
  ): Promise<Stage | "skipped"> {
    const nothingRan = (ending: Stage, reason: string) => ({
      settle: { reason, stage: ending, status: "open" as const },
    });
    const ours = (state: PipelineState) =>
      holds(state, input.attemptId, "route") &&
      state.attempt?.runId === runId &&
      state.stage !== "interrupted";
    /** What the task, as the last write left it, lets this run do. */
    const verdict = (task: Task | undefined): Stage | "skipped" => {
      const state = task === undefined ? undefined : stateOf(task);
      if (state === undefined) {
        return "skipped";
      }
      if (ours(state) && state.stage === "running") {
        return "running";
      }
      const handedBack =
        state.stage === "prepared" &&
        state.history.at(-1)?.attempt === input.attemptId;
      return handedBack ? "prepared" : "skipped";
    };
    try {
      return verdict(
        await own(
          input,
          "route",
          runId,
          nothingRan(
            "failed",
            "Its pipeline state was replaced before its destination started; nothing ran. Retry or reroute explicitly."
          ),
          (task, state) => {
            // Not ours, or a replay of a start this run already committed:
            // nothing to write either way; `verdict` tells them apart.
            if (!ours(state) || state.stage === "running") {
              return;
            }
            if (!member(task)) {
              return withdraw(state, "route");
            }
            const { pin: _used, ...rest } = state;
            return {
              requireReady: true,
              state: { ...rest, route: next.route, stage: "running" },
              status: "active",
            };
          }
        )
      );
    } catch (error) {
      if (!(error instanceof TaskError && error.code === "not_ready")) {
        throw error;
      }
    }
    const held =
      "Something held it back again before it ran; it waits until ready() offers it.";
    return verdict(
      await own(
        input,
        "route",
        runId,
        nothingRan("prepared", held),
        (_task, state) =>
          ours(state) && state.stage !== "running"
            ? { state: settle(state, "prepared", { reason: held }, now()) }
            : undefined
      )
    );
  }

  // ── the observer ───────────────────────────────────────────────────────

  /** Every task carrying the tag, any status. */
  async function tagged(): Promise<Task[]> {
    const found: Task[] = [];
    let cursor: number | undefined;
    do {
      const page = await tasks.list({
        tags: { all: [tag] },
        ...(cursor === undefined ? {} : { cursor }),
      });
      found.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return found;
  }

  async function readyTagged(): Promise<Task[]> {
    const found: Task[] = [];
    let cursor: number | undefined;
    do {
      const page = await tasks.ready({
        tags: { all: [tag] },
        ...(cursor === undefined ? {} : { cursor }),
      });
      found.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return found;
  }

  /**
   * Mark in-flight attempts of stopped instances `interrupted`; their ids.
   * One parked (on a question, or paused) is left alone: the engine keeps
   * its run, and the next host that can answer adopts it.
   */
  async function reconcile(): Promise<string[]> {
    const interrupted: string[] = [];
    for (const task of await tagged()) {
      const state = stateOf(task);
      const stale = state?.attempt;
      if (
        state === undefined ||
        stale === undefined ||
        !isInFlight(state.stage) ||
        stale.owner === owner ||
        stale.parked !== undefined
      ) {
        continue;
      }
      const written = await update(task.id, (_task, current) =>
        isInFlight(current.stage) &&
        current.attempt?.id === stale.id &&
        current.attempt.owner === stale.owner &&
        current.attempt.parked === undefined
          ? { state: interrupt(current, now()) }
          : undefined
      );
      const after = written === undefined ? undefined : stateOf(written);
      if (after?.stage === "interrupted" && after.attempt?.id === stale.id) {
        interrupted.push(task.id);
      }
    }
    return interrupted;
  }

  /** Claim the task's next attempt and launch its run; nothing if another claimed it. */
  async function dispatch(task: Task, kind: Attempt["kind"]): Promise<void> {
    const wanted: Stage = kind === "refine" ? "intake" : "prepared";
    const id = randomUUID();
    const claimed = await update(task.id, (current, state) =>
      state.stage === wanted && current.status === "open" && member(current)
        ? { state: claim(state, kind, owner, id, now()) }
        : undefined
    );
    // `id` is new: only the claim this call committed can hold it.
    if (claimed === undefined || stateOf(claimed)?.attempt?.id !== id) {
      return;
    }
    const input = { attemptId: id, taskId: task.id };
    const definition = kind === "refine" ? refine : attempt;
    // Not awaited: delivery runs one handler at a time, and a run can take
    // hours. Its steps record their own outcome; this catches a launch that
    // failed, or a run that stopped before its steps could.
    definition
      .run(input)
      .catch((error: unknown) => stopped(input, kind, error));
  }

  /**
   * Record a run that ended outside its steps, failed or cancelled, in this
   * process; one parked on a question and cancelled here ends this way too.
   * A host that stops leaves a parked run's promise pending, so this never
   * fails a run the next host can adopt. A later process reconciles what
   * this cannot write.
   */
  async function stopped(
    input: AttemptInput,
    kind: Attempt["kind"],
    error: unknown
  ): Promise<void> {
    try {
      await end(
        input,
        kind,
        undefined,
        "failed",
        { reason: `The ${kind} run stopped: ${message(error)}` },
        "open"
      );
    } catch {
      // The records are closed with the host; the next one reconciles.
    }
  }

  observe(tasks, async (event) => {
    for (const delta of event.tasks) {
      await enter(delta);
    }
    await wakePipeline();
  });

  /**
   * Enroll or restore one changed task; never from the state alone, so a
   * pass never takes a task whose state was dropped for a new one.
   *
   * - A change that dropped the task's state offers it back as it was,
   *   history and attempt included, with what its attempt's run noted
   *   meanwhile applied to it. This holds whether or not the task still has
   *   the tag, which only decides what starts: removing it in the same
   *   change resets nothing, and tagging it again goes on from there.
   * - A change that made the task tagged and open (created it so, tagged
   *   it, or reopened it) offers to enroll it at `intake`, which happens
   *   only if it then has no state and no notes. Notes mean a run of a
   *   dropped state is still out, so only an explicit `refine` enrolls such
   *   a task. Any other change offers nothing, so a task left without its
   *   state never starts over.
   * - An offer is decided only at the task's current version. When the
   *   task has changed since, the offer is written onto the task as its
   *   `pending` (see `state.ts`) before this change is acknowledged, and
   *   decided by the change the observer reaches at the current version;
   *   the observer's own write of it is such a change. Until then nothing
   *   runs from it. Delivery hands the observer a change only after it
   *   completed every earlier one, so when it decides, every earlier
   *   change's offer or supersession is already on the task, however many
   *   of its writes failed. Only a later offer replaces it, so a change
   *   handed again (its completion unsaved, or an edited observer replaying
   *   the history) never wins over the latest one. A change that gives
   *   the task a state supersedes it: the task has none now, so a later
   *   change dropped that state, and its own offer is the one to keep.
   * - A change that drops a pending (an overwrite of the key) offers it
   *   again under its own `from`, never as a newer offer, so the
   *   observer's writes that supersede or settle one never win over a
   *   later drop.
   * - A later overwrite can drop a run's notes before the restore reads
   *   them, so an ending noted in a change's images lands on the restored
   *   or current state, and is kept with a pending. A park lands only from
   *   the task as it is: applied again after its run resumed, it would park
   *   a running attempt.
   */
  async function enter(delta: TaskDelta): Promise<void> {
    const { after, before } = delta;
    if (after === null) {
      return;
    }
    const endings = [...notesOf(before), ...notesOf(after)].filter(
      (note) => note.settle !== undefined
    );
    const given = stateOf(after) !== undefined;
    const offer = given ? undefined : offerOf(before, after, tag);
    const owed = pendingOf(after) !== undefined;
    if (!(given || owed || offer !== undefined || endings.length > 0)) {
      return;
    }
    await write(after.id, (task, state) =>
      state === undefined
        ? owing(task, after, offer, endings)
        : land(state, [...notesOf(task), ...endings])
    );
  }

  /**
   * The write a change `after` asks of a task that has no state now: with
   * a state in `after`, supersede what is owed; otherwise keep the newer of
   * `offer` and the task's pending, decided at the current version and
   * recorded on the task before that. An enrollment never replaces a state
   * owed back: tagging or reopening the task meanwhile goes on from that
   * state, as it does once the state is back.
   */
  function owing(
    task: Task,
    after: Task,
    offer: Pending | undefined,
    endings: readonly Note[]
  ): Write | undefined {
    const { notes, pending } = stateless(task);
    const kept = withEndings(notes, endings);
    if (stateOf(after) !== undefined) {
      const superseded =
        pending !== undefined &&
        owes(pending) &&
        pending.from < after.updatedAt;
      return superseded
        ? { state: { notes: kept, pending: { from: after.updatedAt } } }
        : undefined;
    }
    const restores = pending?.image !== undefined;
    const newer =
      offer !== undefined &&
      (pending === undefined || pending.from < offer.from) &&
      !(offer.enroll === true && restores);
    const next = newer ? offer : pending;
    if (next === undefined) {
      return;
    }
    if (task.updatedAt === after.updatedAt) {
      return decidePending(task, next, kept);
    }
    return newer || kept.length !== notes.length
      ? { state: { notes: kept, pending: next } }
      : undefined;
  }

  /** What a pending comes to at the task's current version. */
  function decidePending(
    task: Task,
    pending: Pending,
    notes: readonly Note[]
  ): Write | undefined {
    if (pending.image !== undefined) {
      return land(pending.image, notes) ?? { state: pending.image };
    }
    if (pending.enroll === true) {
      return member(task) && notes.length === 0 && task.status === "open"
        ? { state: enrolled(now(), `tagged ${tag}`) }
        : { state: { notes: [...notes], pending: { from: pending.from } } };
    }
    return notes.length === notesOf(task).length
      ? undefined
      : { state: { notes: [...notes], pending } };
  }

  /** One pass: reconcile, refine what is new, route what is prepared and ready. */
  async function wakePipeline(): Promise<void> {
    await reconcile();
    for (const task of await tagged()) {
      if (task.status === "open" && stateOf(task)?.stage === "intake") {
        await dispatch(task, "refine");
      }
    }
    for (const task of await readyTagged()) {
      if (stateOf(task)?.stage === "prepared") {
        await dispatch(task, "route");
      }
    }
  }

  // ── what a user launches ───────────────────────────────────────────────

  const requestStep = step(`${name}-request`)
    .describe(
      "Move a pipeline task on: accept its result, refine again, prepare as is, retry, reroute (optionally to a named destination), or abandon an attempt parked on a question or paused."
    )
    .input(requestInput)
    .do(async ({ input }) => {
      const task = await tasks.get(input.taskId);
      if (task === null) {
        throw new Error(`Task ${input.taskId} not found`);
      }
      // The tag decides what starts. Accepting a result or abandoning a
      // parked attempt settles in place and starts nothing, so a task that
      // left the pipeline can still settle what it began there.
      const settlesInPlace =
        input.action === "accept" || input.action === "abandon";
      if (!(settlesInPlace || task.tags.includes(tag))) {
        throw new Error(
          `Task ${task.id} is not in the pipeline; tag it "${tag}"`
        );
      }
      // `refine` alone may start such a task over, without its history.
      if (
        input.action !== "refine" &&
        stateOf(task) === undefined &&
        pendingOf(task)?.image !== undefined
      ) {
        throw new Error(
          `Task ${task.id}'s pipeline state is being put back; try again once it is`
        );
      }
      const change = requested(input, task);
      const written = await write(task.id, (current, state) => ({
        state: request(state, current, change, now()),
        ...statusFor(change, current),
      }));
      if (written === undefined) {
        throw new Error(`Task ${task.id} not found`);
      }
      return { stage: stateOf(written)?.stage, taskId: written.id };
    });

  /** A request, with a user's route checked against the destinations now. */
  function requested(
    input: z.output<typeof requestInput>,
    task: Task
  ): Request {
    if (input.action !== "reroute") {
      return { action: input.action };
    }
    if (input.workflow === undefined) {
      return { action: "reroute" };
    }
    const pin: Pin = {
      input: input.input,
      reason: input.reason,
      source: "user",
      workflow: input.workflow,
    };
    const checked = check(
      pinnedDecision(pin),
      destinations,
      briefOf(task),
      pin
    );
    if (checked.kind !== "route") {
      throw new Error(checked.reason);
    }
    return { action: "reroute", pin };
  }

  const reconcileStep = step(`${name}-reconcile`)
    .describe(
      "Mark attempts whose host process stopped as interrupted, then refine and route what is waiting."
    )
    .do(async () => {
      const interrupted = await reconcile();
      await wakePipeline();
      return { interrupted };
    });

  return {
    attempt,
    reconcile: reconcileStep,
    refine,
    request: requestStep,
    tag,
  };
}

/**
 * The task status a request leaves: an accepted result completes the task,
 * which settles it for its dependents; anything else in progress reopens it.
 */
function statusFor(change: Request, task: Task): { status?: TaskStatus } {
  if (change.action === "accept") {
    return { status: "completed" };
  }
  return task.status === "active" ? { status: "open" } : {};
}

/**
 * The batch for one pipeline write: the new state under the token the task
 * was read at, and its status when that changes on an unsettled task. A
 * status that requires readiness is always written, so the store checks the
 * task's readiness when the batch commits and refuses with `not_ready`.
 */
function operations(task: Task, next: Write): TaskOperation[] {
  const { id } = task;
  const update: TaskOperation = {
    expectedUpdatedAt: task.updatedAt,
    kind: "task.update",
    patch: { metadata: { ...task.metadata, [METADATA_KEY]: json(next.state) } },
    task: { id },
  };
  if (next.requireReady === true && next.status !== undefined) {
    return [
      update,
      {
        kind: "task.set_status",
        requireReady: true,
        status: next.status,
        task: { id },
      },
    ];
  }
  const settled = task.status === "completed" || task.status === "cancelled";
  if (next.status === undefined || next.status === task.status || settled) {
    return [update];
  }
  return [
    update,
    { kind: "task.set_status", status: next.status, task: { id } },
  ];
}

/**
 * What a change that leaves the task without a state offers: the state it
 * dropped; the pending it dropped, under that pending's own `from`; or,
 * when it made the task tagged and open, its enrollment.
 */
function offerOf(
  before: Task | null,
  after: Task,
  tag: string
): Pending | undefined {
  const image = before === null ? undefined : stateOf(before);
  if (image !== undefined) {
    return { from: after.updatedAt, image };
  }
  const dropped = pendingOf(before);
  if (dropped !== undefined && pendingOf(after) === undefined) {
    return dropped;
  }
  const enrollable = (task: Task | null) =>
    task?.status === "open" && task.tags.includes(tag);
  return enrollable(after) && !enrollable(before)
    ? { enroll: true, from: after.updatedAt }
    : undefined;
}

/** Whether a pending still asks for anything. */
function owes(pending: Pending): boolean {
  return pending.image !== undefined || pending.enroll === true;
}

/** `notes`, with each ending not among them yet added. */
function withEndings(notes: readonly Note[], endings: readonly Note[]): Note[] {
  const seen = new Set(notes.map((note) => JSON.stringify(note)));
  const added = endings.filter((note) => {
    const key = JSON.stringify(note);
    const fresh = !seen.has(key);
    seen.add(key);
    return fresh;
  });
  return [...notes, ...added];
}

/** The exact routing model, or why there is none. */
function routerModel(
  configured: string | undefined
): string | { reason: string } {
  const value = (configured ?? process.env[ROUTER_MODEL_ENV] ?? "").trim();
  if (value === "") {
    return {
      reason: `No routing model is configured. Set ${ROUTER_MODEL_ENV}, or router.model, to an exact model id your Codex CLI lists.`,
    };
  }
  if (!MODEL_ID.test(value)) {
    return { reason: `${JSON.stringify(value)} is not a model id.` };
  }
  return value;
}

function routeOf(choice: ModelChoice | undefined): AgentRoute {
  return {
    ...(choice?.provider === undefined ? {} : { provider: choice.provider }),
    ...(choice?.model === undefined ? {} : { model: choice.model }),
  };
}

function requireDistinctNames(destinations: readonly Destination[]): void {
  const names = destinations.map(destinationName);
  const repeated = names.find((value, index) => names.indexOf(value) !== index);
  if (repeated !== undefined) {
    throw new Error(`task pipeline: destination "${repeated}" is listed twice`);
  }
}

function now(): string {
  return new Date().toISOString();
}

/**
 * The engine's signal that a step parked on a question: a run that is
 * suspended, not failed. The authoring surface does not export its class,
 * so it is known by the name the engine gives it.
 */
function isSuspension(error: unknown): boolean {
  return error instanceof Error && error.name === "SuspendSignal";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A destination's output as stored on the task: JSON, cut short. */
function preview(output: unknown): string {
  const text = JSON.stringify(output) ?? "null";
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}… (cut; the run keeps all of it)`
    : text;
}

/** The state, or a run's notes, as metadata takes it: plain JSON. */
function json(state: PipelineState | Notes): Task["metadata"][string] {
  return JSON.parse(JSON.stringify(state));
}
