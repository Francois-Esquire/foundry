import { randomUUID } from "node:crypto";
import type { SessionEvent, TaskContext } from "@foundry.sh/marbles/engine";
import { AsyncIteratorClass, EventPublisher } from "@orpc/server";
import {
  type AuthoringAcceptResult,
  type AuthoringAnswer,
  type AuthoringConversationView,
  type AuthoringEvent,
  type AuthoringItem,
  type AuthoringProposalFiles,
  type AuthoringRoute,
  type AuthoringTurnView,
  appendText,
  isSettledTurn,
  type ProposalFiles,
} from "~/shared/authoring";
import { WORKS_TASKS } from "~/shared/execution";
import { type ModuleSourceRevision, sameRevision } from "~/shared/modules";
import type { WorksExecution } from "../../execution/contract";
import type { ModuleLibrary } from "../library";
import type { ModuleSandboxes } from "../sandboxes/coordinator";
import type { AuthoringTurnLimits } from "../settings";
import { admitSource, SOURCE_LIMITS } from "../source-admission";
import {
  AUTHORING_LIMITS,
  type AuthoringApprovalHandler,
  type AuthoringQuestionHandler,
  type AuthoringTurnRunner,
  runAuthoringAgent,
} from "./agent";
import { AuthoringStore, type TurnRecord } from "./store";
import {
  collectWorkspace,
  proposedChanges,
  seedWorkspace,
  validateProposal,
} from "./workspace";

/** Settled turns kept per Module; older ones go once nothing is pending on them. */
const RETAINED_TURNS = 50;
const SAVED_SOURCE_CHANGED =
  "Saved source changed since this request was sent, so the proposal was not applied. Compare it or resolve it file by file.";

/** Where a turn's model calls go, with provider credentials read from the vault now. */
export interface AuthoringModels {
  route(): AuthoringRoute;
}

export interface ModuleAuthoringOptions {
  /** Overrides every Module's `authoring.deadline` setting (tests). */
  readonly deadlineMs?: number;
  /** Where conversations, turns, snapshots and proposals are kept. */
  readonly directory: string;
  readonly execution: Pick<WorksExecution, "launch">;
  /** Saved source, read through disk synchronization. */
  readonly library: Pick<ModuleLibrary, "details">;
  /**
   * A Module's turn limits from its effective settings, read when a turn is
   * sent. Host defaults when absent.
   */
  readonly limits?: (moduleId: string) => Promise<AuthoringTurnLimits>;
  /** Overrides every Module's `authoring.maxSteps` setting (tests). */
  readonly maxSteps?: number;
  readonly models: AuthoringModels;
  /** The agent; tests supply a scripted one. */
  readonly runner?: AuthoringTurnRunner;
  readonly sandboxes: Pick<ModuleSandboxes, "borrow">;
}

export interface SendTurn {
  /** The saved source the Draft is bound to. */
  readonly binding: ModuleSourceRevision;
  readonly prompt: string;
  /** The Draft as the user sees it now. */
  readonly source: Record<string, string>;
}

interface PendingInput {
  answer(answer: AuthoringAnswer): void;
}

/** A turn of this process: its cancel switch and the questions it is waiting on. */
interface LiveTurn {
  readonly controller: AbortController;
  /** Settles once the turn's outcome is recorded. */
  done?: Promise<void>;
  readonly inputs: Map<string, PendingInput>;
}

interface ModuleState {
  readonly live: Map<string, LiveTurn>;
  readonly publisher: EventPublisher<{ event: AuthoringEvent }>;
  route?: AuthoringRoute;
  sessionId?: string;
  readonly turns: Map<string, TurnRecord>;
  writes: Promise<void>;
}

class CancelledTurnError extends Error {
  override readonly name = "CancelledTurnError";
}

/**
 * The Module authoring chat in main: one conversation per Module, each turn
 * an engine run on that Module's authoring queue, working in the Module's
 * sandbox on a snapshot of the Draft, and ending in an Edit proposal the
 * renderer reconciles into the Draft. Works never saves on the agent's
 * behalf: accepting only returns the proposal once the saved binding is
 * confirmed unchanged.
 */
export class ModuleAuthoring {
  readonly #deadlineMs: number | undefined;
  readonly #execution: Pick<WorksExecution, "launch">;
  readonly #library: Pick<ModuleLibrary, "details">;
  readonly #limits: (moduleId: string) => Promise<AuthoringTurnLimits>;
  readonly #maxSteps: number | undefined;
  readonly #models: AuthoringModels;
  readonly #modules = new Map<string, Promise<ModuleState>>();
  readonly #runner: AuthoringTurnRunner;
  readonly #sandboxes: Pick<ModuleSandboxes, "borrow">;
  readonly #store: AuthoringStore;

  constructor(options: ModuleAuthoringOptions) {
    this.#deadlineMs = options.deadlineMs;
    this.#execution = options.execution;
    this.#library = options.library;
    this.#limits =
      options.limits ??
      (() => Promise.resolve({ ...AUTHORING_LIMITS, source: SOURCE_LIMITS }));
    this.#maxSteps = options.maxSteps;
    this.#models = options.models;
    this.#runner = options.runner ?? runAuthoringAgent;
    this.#sandboxes = options.sandboxes;
    this.#store = new AuthoringStore(options.directory);
  }

  /**
   * A Module's state, read once per process. What an earlier process left
   * queued or running, or waiting on the user, is recorded as interrupted:
   * nothing of this process is working on it.
   */
  #state(moduleId: string): Promise<ModuleState> {
    let state = this.#modules.get(moduleId);
    if (!state) {
      state = this.#load(moduleId);
      state.catch(() => this.#modules.delete(moduleId));
      this.#modules.set(moduleId, state);
    }
    return state;
  }

  async #load(moduleId: string): Promise<ModuleState> {
    const [conversation, records] = await Promise.all([
      this.#store.conversation(moduleId),
      this.#store.turns(moduleId),
    ]);
    const state: ModuleState = {
      ...conversation,
      live: new Map(),
      publisher: new EventPublisher(),
      turns: new Map(records.map((turn) => [turn.id, turn])),
      writes: Promise.resolve(),
    };
    for (const turn of records) {
      if (!isSettledTurn(turn.status) || turn.items.some(isOpenInput)) {
        if (!isSettledTurn(turn.status)) {
          turn.status = "interrupted";
          turn.error = "Works closed before this request finished.";
        }
        turn.items = turn.items.map(interrupted);
        await this.#store.writeTurn(turn);
      }
    }
    return state;
  }

  async conversation(moduleId: string): Promise<AuthoringConversationView> {
    const state = await this.#state(moduleId);
    return { moduleId, turns: [...state.turns.values()].map(view) };
  }

  /** The conversation now, then every change to it. Ending the watch never cancels a turn. */
  watch(
    moduleId: string,
    signal?: AbortSignal
  ): AsyncIteratorClass<AuthoringEvent> {
    const ready = this.#state(moduleId);
    let events: ReturnType<ModuleState["publisher"]["subscribe"]> | undefined;
    return new AsyncIteratorClass(
      async () => {
        const state = await ready;
        if (events) {
          return await events.next();
        }
        // Subscribe and snapshot in the same tick, so no event is both in
        // the snapshot and replayed after it (a text delta would repeat).
        events = state.publisher.subscribe("event", { signal });
        return {
          done: false,
          value: {
            conversation: {
              moduleId,
              turns: [...state.turns.values()].map(view),
            },
            type: "conversation",
          },
        };
      },
      async () => {
        await events?.return();
      }
    );
  }

  /**
   * Start a turn. The Draft snapshot and its binding are kept with the turn
   * before anything runs; the turn then waits its place on the Module's
   * authoring queue.
   */
  async send(moduleId: string, request: SendTurn): Promise<AuthoringTurnView> {
    const configured = await this.#limits(moduleId);
    const limits: AuthoringTurnLimits = {
      ...configured,
      deadlineMs: this.#deadlineMs ?? configured.deadlineMs,
      maxSteps: this.#maxSteps ?? configured.maxSteps,
    };
    admitSource(request.source, limits.source);
    const state = await this.#state(moduleId);
    const route = this.#models.route();
    let { sessionId } = state;
    let notice: string | undefined;
    if (sessionId === undefined || state.route?.provider !== route.provider) {
      if (sessionId !== undefined && state.route) {
        notice = `The model provider changed from ${state.route.provider} to ${route.provider}, so this request starts a new conversation.`;
      }
      sessionId = randomUUID();
    }
    const turn: TurnRecord = {
      agentSessionId: sessionId,
      binding: request.binding,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      items: [],
      moduleId,
      ...(notice === undefined ? {} : { notice }),
      prompt: request.prompt,
      route,
      status: "queued",
    };
    await this.#store.writeSnapshot(moduleId, turn.id, request.source);
    await this.#store.writeTurn(turn);
    state.sessionId = sessionId;
    state.route = route;
    await this.#store.writeConversation(moduleId, { route, sessionId });
    state.turns.set(turn.id, turn);
    this.#publish(state, { turn: view(turn), type: "turn" });
    const live: LiveTurn = {
      controller: new AbortController(),
      inputs: new Map(),
    };
    state.live.set(turn.id, live);
    try {
      const launched = await this.#execution.launch(
        WORKS_TASKS.authoringTurn,
        {
          correlation: { agentSessionId: sessionId, moduleId, turnId: turn.id },
          queue: { kind: "authoring", moduleId },
          // Provider failures can quote what was sent; the turn record
          // keeps the message, the run store only its code.
          recordErrorMessage: false,
          signal: live.controller.signal,
        },
        (context) =>
          this.#run(context, state, turn, {
            limits,
            live,
            source: request.source,
          })
      );
      turn.runId = launched.id;
      this.#save(state, turn);
      live.done = launched.result.then(
        () => this.#settled(state, turn, live),
        (error: unknown) => this.#settled(state, turn, live, error)
      );
    } catch (error) {
      this.#settled(state, turn, live, error);
    }
    await this.#prune(moduleId, state).catch(() => undefined);
    return view(turn);
  }

  /** Cancel a queued or running turn. Its run is recorded cancelled. */
  async cancel(moduleId: string, turnId: string): Promise<void> {
    const state = await this.#state(moduleId);
    state.live.get(turnId)?.controller.abort(new CancelledTurnError());
  }

  /** Answer a question or approval the turn is waiting on. */
  async answer(
    moduleId: string,
    turnId: string,
    inputId: string,
    answer: AuthoringAnswer
  ): Promise<void> {
    const state = await this.#state(moduleId);
    const pending = state.live.get(turnId)?.inputs.get(inputId);
    if (!pending) {
      throw new Error("The agent is no longer waiting for this answer.");
    }
    pending.answer(answer);
  }

  /** A proposal and the captured files it changes, for comparison. */
  async proposal(
    moduleId: string,
    turnId: string
  ): Promise<AuthoringProposalFiles> {
    const state = await this.#state(moduleId);
    const turn = state.turns.get(turnId);
    if (!turn?.proposal) {
      throw new Error("This request has no proposal.");
    }
    const [snapshot, proposal] = await Promise.all([
      this.#store.snapshot(moduleId, turnId),
      this.#store.proposal(moduleId, turnId),
    ]);
    const base: ProposalFiles = {};
    for (const path of Object.keys(proposal)) {
      base[path] = Object.hasOwn(snapshot, path)
        ? (snapshot[path] ?? null)
        : null;
    }
    return { base, proposal };
  }

  /**
   * Hand a pending proposal to the renderer to reconcile, once the saved
   * source is confirmed to be what the turn started from. Reading details
   * runs disk synchronization first, so a disk save during the turn counts.
   * A moved binding refuses: nothing is applied and the proposal is kept.
   */
  async accept(
    moduleId: string,
    turnId: string
  ): Promise<AuthoringAcceptResult> {
    const state = await this.#state(moduleId);
    const turn = state.turns.get(turnId);
    if (turn?.proposal?.status !== "pending") {
      throw new Error("This proposal is no longer waiting for review.");
    }
    const saved = await this.#library.details(moduleId);
    if (!(saved?.binding && sameRevision(saved.binding, turn.binding))) {
      return { message: SAVED_SOURCE_CHANGED, status: "stale" };
    }
    return { status: "ready", ...(await this.proposal(moduleId, turnId)) };
  }

  /** Record what the renderer did with a proposal: applied to the Draft, or dismissed. */
  async settleProposal(
    moduleId: string,
    turnId: string,
    status: "applied" | "dismissed"
  ): Promise<AuthoringTurnView> {
    const state = await this.#state(moduleId);
    const turn = state.turns.get(turnId);
    if (turn?.proposal?.status !== "pending") {
      throw new Error("This proposal is no longer waiting for review.");
    }
    turn.proposal = { ...turn.proposal, status };
    await this.#save(state, turn);
    return view(turn);
  }

  /** Cancel every turn of this process; quit waits for their runs to end. */
  async shutdown(): Promise<void> {
    const states = await Promise.allSettled(this.#modules.values());
    for (const state of states) {
      if (state.status === "fulfilled") {
        const live = [...state.value.live.values()];
        for (const turn of live) {
          turn.controller.abort(
            new CancelledTurnError("Works closed before this request finished.")
          );
        }
        await Promise.allSettled(live.map((turn) => turn.done));
        await state.value.writes;
      }
    }
  }

  async #run(
    context: TaskContext,
    state: ModuleState,
    turn: TurnRecord,
    {
      limits,
      live,
      source,
    }: {
      readonly limits: AuthoringTurnLimits;
      readonly live: LiveTurn;
      readonly source: Record<string, string>;
    }
  ): Promise<void> {
    turn.status = "running";
    this.#save(state, turn);
    // Credentials are read again now: a key changed while the turn waited
    // applies, and a provider that went away fails it plainly.
    if (this.#models.route().provider !== turn.route.provider) {
      throw new Error(
        "The model provider changed while this request waited. Send it again."
      );
    }
    const deadline = AbortSignal.timeout(limits.deadlineMs);
    const loan = await this.#sandboxes.borrow(turn.moduleId, {
      signal: AbortSignal.any([context.signal, deadline]),
      waiting: () => {
        turn.waiting = true;
        this.#save(state, turn);
      },
    });
    if (turn.waiting) {
      turn.waiting = false;
      this.#save(state, turn);
    }
    const signal = AbortSignal.any([context.signal, loan.signal, deadline]);
    try {
      await seedWorkspace(loan.container, source, signal);
      await this.#runner({
        approve: this.#approval(state, turn, live),
        container: loan.container,
        context,
        maxSteps: limits.maxSteps,
        onEvent: (event) => this.#event(state, turn, event),
        prompt: turn.prompt,
        question: this.#question(state, turn, live),
        route: turn.route,
        sessionId: turn.agentSessionId,
        signal,
      });
      signal.throwIfAborted();
      const changes = proposedChanges(
        source,
        await collectWorkspace(loan.container, source, signal)
      );
      const paths = Object.keys(changes).sort();
      if (paths.length === 0) {
        return;
      }
      try {
        validateProposal(source, changes, limits.source);
      } catch (error) {
        throw new Error(
          `The agent's changes could not be offered. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      await this.#store.writeProposal(turn.moduleId, turn.id, changes);
      turn.proposal = { paths, status: "pending" };
      // Kept now: a restart before the run settles still offers it.
      await this.#save(state, turn);
    } catch (error) {
      if (deadline.aborted && !context.signal.aborted) {
        throw new Error(
          `The request reached its ${Math.round(limits.deadlineMs / 60_000)}-minute limit.`,
          { cause: error }
        );
      }
      if (loan.signal.aborted && !context.signal.aborted) {
        throw new Error("The Module sandbox stopped during the request.", {
          cause: error,
        });
      }
      throw error;
    } finally {
      loan.release();
    }
  }

  /** How a turn ended, recorded once its run has settled. */
  #settled(
    state: ModuleState,
    turn: TurnRecord,
    live: LiveTurn,
    error?: unknown
  ): void {
    state.live.delete(turn.id);
    const { reason } = live.controller.signal;
    if (error === undefined) {
      turn.status = "complete";
    } else if (live.controller.signal.aborted) {
      turn.status = "cancelled";
      if (reason instanceof Error && reason.message) {
        turn.error = reason.message;
      }
    } else {
      turn.status = "failed";
      turn.error =
        error instanceof Error && error.message
          ? error.message
          : "The request failed.";
    }
    turn.items = turn.items.map((item) => {
      if (item.kind === "tool" && item.status === "running") {
        return { ...item, status: "cancelled" };
      }
      if (
        (item.kind === "question" || item.kind === "approval") &&
        item.status === "open"
      ) {
        return { ...item, status: "cancelled" };
      }
      return item;
    });
    this.#save(state, turn);
  }

  #event(state: ModuleState, turn: TurnRecord, event: SessionEvent): void {
    if (event.type === "text-delta") {
      turn.items = appendText(turn.items, event.delta);
      this.#publish(state, {
        delta: event.delta,
        turnId: turn.id,
        type: "text",
      });
      return;
    }
    if (event.type === "tool-call" && event.name !== "ask_user") {
      turn.items = [
        ...turn.items,
        {
          id: event.toolCallId,
          kind: "tool",
          name: event.name,
          status: "running",
        },
      ];
      this.#publish(state, { turn: view(turn), type: "turn" });
      return;
    }
    if (event.type === "tool-result" && !event.preliminary) {
      const denial = deniedReason(event.output);
      turn.items = turn.items.map((item) => {
        if (item.kind !== "tool" || item.id !== event.toolCallId) {
          return item;
        }
        if (denial !== undefined) {
          return { ...item, reason: denial, status: "denied" };
        }
        return { ...item, status: event.isError ? "failed" : "complete" };
      });
      this.#publish(state, { turn: view(turn), type: "turn" });
    }
  }

  /** `ask_user`, shown in the owning chat until answered or the turn ends. */
  #question(
    state: ModuleState,
    turn: TurnRecord,
    live: LiveTurn
  ): AuthoringQuestionHandler {
    return (request) =>
      this.#wait(state, turn, live, request.signal, {
        id: request.toolCallId,
        kind: "question",
        questions: request.questions,
        status: "open",
      }).then((answer) => {
        if (answer.kind === "answer") {
          return { answers: answer.answers, outcome: "answered" };
        }
        return {
          outcome: "declined",
          reason:
            answer.kind === "decline" && answer.reason
              ? answer.reason
              : "The user declined to answer.",
        };
      });
  }

  /** A live approval, shown in the owning chat until decided or the turn ends. */
  #approval(
    state: ModuleState,
    turn: TurnRecord,
    live: LiveTurn
  ): AuthoringApprovalHandler {
    return (request) =>
      this.#wait(state, turn, live, request.signal, {
        id: request.approvalId,
        kind: "approval",
        status: "open",
        summary: request.inputSummary ?? "",
        toolName: request.toolName,
      }).then((answer) => ({
        approved: answer.kind === "approval" && answer.approved,
        lifetime: "once",
        ...(answer.kind === "approval" ? {} : { reason: "Declined." }),
      }));
  }

  async #wait(
    state: ModuleState,
    turn: TurnRecord,
    live: LiveTurn,
    signal: AbortSignal,
    item: Extract<AuthoringItem, { kind: "question" | "approval" }>
  ): Promise<AuthoringAnswer> {
    signal.throwIfAborted();
    const mark = (status: typeof item.status) => {
      turn.items = turn.items.map((entry) =>
        entry.kind === item.kind && entry.id === item.id
          ? { ...entry, status }
          : entry
      );
      this.#save(state, turn);
    };
    // On disk before anyone can see or answer it, so a restart at any point
    // after that reports it interrupted instead of forgetting it was asked.
    const record = structuredClone(turn);
    record.items = [...record.items, item];
    await this.#write(state, record);
    turn.items = [...turn.items, item];
    if (signal.aborted) {
      mark("cancelled");
      signal.throwIfAborted();
    }
    this.#publish(state, { turn: view(turn), type: "turn" });
    return await new Promise<AuthoringAnswer>((resolve, reject) => {
      const stop = () => {
        live.inputs.delete(item.id);
        mark("cancelled");
        reject(signal.reason);
      };
      signal.addEventListener("abort", stop, { once: true });
      live.inputs.set(item.id, {
        answer: (answer) => {
          if ((item.kind === "approval") !== (answer.kind === "approval")) {
            throw new Error("That answer does not fit this request.");
          }
          signal.removeEventListener("abort", stop);
          live.inputs.delete(item.id);
          mark(answer.kind === "decline" ? "declined" : "answered");
          resolve(answer);
        },
      });
    });
  }

  /** Keep the turn and tell watchers. Writes go in order; the latest wins. */
  #save(state: ModuleState, turn: TurnRecord): Promise<void> {
    const record = structuredClone(turn);
    this.#publish(state, { turn: view(record), type: "turn" });
    return this.#write(state, record);
  }

  /** Queue one record write after the earlier ones. */
  #write(state: ModuleState, record: TurnRecord): Promise<void> {
    state.writes = state.writes
      .then(() => this.#store.writeTurn(record))
      .catch(() => undefined);
    return state.writes;
  }

  #publish(state: ModuleState, event: AuthoringEvent) {
    state.publisher.publish("event", event);
  }

  /** Forget the oldest settled turns beyond the retained count, unless a proposal awaits review. */
  async #prune(moduleId: string, state: ModuleState) {
    const removable = [...state.turns.values()].filter(
      (turn) =>
        isSettledTurn(turn.status) && turn.proposal?.status !== "pending"
    );
    for (const turn of removable.slice(
      0,
      Math.max(0, state.turns.size - RETAINED_TURNS)
    )) {
      state.turns.delete(turn.id);
      await this.#store.remove(moduleId, turn.id);
    }
  }
}

function view(turn: TurnRecord): AuthoringTurnView {
  return {
    createdAt: turn.createdAt,
    ...(turn.error === undefined ? {} : { error: turn.error }),
    id: turn.id,
    items: turn.items,
    ...(turn.notice === undefined ? {} : { notice: turn.notice }),
    prompt: turn.prompt,
    ...(turn.proposal === undefined ? {} : { proposal: turn.proposal }),
    route: turn.route,
    status: turn.status,
    ...(turn.waiting ? { waiting: true } : {}),
  };
}

function isOpenInput(item: AuthoringItem) {
  return (
    (item.kind === "question" || item.kind === "approval") &&
    item.status === "open"
  );
}

function interrupted(item: AuthoringItem): AuthoringItem {
  if (isOpenInput(item)) {
    return { ...item, status: "interrupted" } as AuthoringItem;
  }
  if (item.kind === "tool" && item.status === "running") {
    return { ...item, status: "cancelled" };
  }
  return item;
}

/** A refusal the tool compiler returns in place of a result. */
function deniedReason(output: unknown): string | undefined {
  if (
    typeof output === "object" &&
    output !== null &&
    "approved" in output &&
    output.approved === false
  ) {
    return "reason" in output && typeof output.reason === "string"
      ? output.reason
      : "Denied.";
  }
  return undefined;
}
