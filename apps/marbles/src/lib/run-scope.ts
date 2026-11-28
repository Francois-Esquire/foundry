import type { ChannelMessage } from "@foundry/workflows/channels";
import { parseSuspensionOccurrenceKey } from "@foundry/workflows/executable";
import type { Step } from "@foundry/workflows/step";
import { ambient, type ContextVariable } from "./async-context";
import type { Bindings, HostBindings } from "./bindings";
import type { AnyDefinition } from "./definition";
import { Ledger } from "./ledger";
import type { LiveWork, StepInput } from "./step-work";
import { StepInputError, StepWork } from "./step-work";
import type { SessionRef } from "./types";

interface Closable {
  close(): Promise<void> | void;
}

interface Pause {
  readonly reason: string;
}

export const PAUSE_KIND = "marbles.pause";

export interface Frame {
  controller: AbortController;
  readonly counters: Map<string, number>;
  detached: readonly Promise<unknown>[];
  failed?: boolean;
  readonly key: string;
  readonly opened: Set<Closable>;
  readonly path: readonly string[];
  paused?: Pause;
  resumePrompt?: string;
  signal: AbortSignal;
  readonly work: StepWork;
}

export interface Current {
  readonly bindings: Bindings;
  readonly cwd: string;
  readonly frame: Frame;
  readonly run: (definition: AnyDefinition, input: unknown) => Promise<unknown>;
  readonly scope: RunScope;
  readonly write: (value: unknown) => void;
}

function scoped<T>(variable: ContextVariable<T>) {
  return {
    exit: <R>(work: () => R): R => variable.exit(work),
    getStore: (): T | undefined => variable.get(),
    run: <R>(value: T, work: () => R): R => variable.run(value, work),
  };
}

export const current = scoped(ambient.currentRun);

export const setupCounters = scoped(ambient.setupCounters);

export function workingDirectory(fallback: string): string {
  return current.getStore()?.cwd ?? fallback;
}

type Literal = Readonly<Record<string, unknown>>;

export interface RecordedScope {
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly literals?: Readonly<Record<string, Literal>>;
  readonly session: SessionRef;
}

export type Resolutions = ReadonlyMap<string, unknown>;

function pauseAnswers(
  resolutions: Resolutions
): ReadonlyMap<string, readonly unknown[]> {
  const indexed = new Map<string, [number, unknown][]>();
  for (const [key, value] of resolutions) {
    const parsed = parseSuspensionOccurrenceKey(key);
    const index = parsed?.name.startsWith(`${PAUSE_KIND}:`)
      ? Number(parsed.name.slice(PAUSE_KIND.length + 1))
      : Number.NaN;
    if (parsed === undefined || !Number.isSafeInteger(index)) {
      continue;
    }
    const frame = parsed.stepPath.join(".");
    indexed.set(frame, [...(indexed.get(frame) ?? []), [index, value]]);
  }
  return new Map(
    [...indexed].map(([frame, answers]) => [
      frame,
      answers.sort(([one], [other]) => one - other).map(([, value]) => value),
    ])
  );
}

function promptOf(answer: unknown): string | undefined {
  if (typeof answer !== "object" || answer === null) {
    return;
  }
  const prompt: unknown = Reflect.get(answer, "prompt");
  return typeof prompt === "string" && prompt !== "" ? prompt : undefined;
}

export type StoredScopes = (
  runId: string
) => Promise<RecordedScope | undefined>;

export class RunScope {
  readonly controller = new AbortController();
  readonly cwd: string;
  readonly frames = new Map<string, Frame>();
  readonly host: HostBindings;
  readonly id: string;
  readonly ledger: Ledger;
  readonly literals = new Map<string, Literal>();
  readonly session: SessionRef;
  readonly #answers: ReadonlyMap<string, readonly unknown[]>;
  #ended: Promise<void> | undefined;
  #root: Step | undefined;

  constructor(
    id: string,
    cwd: string,
    host: HostBindings = {},
    previous?: RecordedScope,
    resolutions: Resolutions = new Map()
  ) {
    this.id = id;
    this.#answers = pauseAnswers(resolutions);
    this.cwd = cwd;
    this.host = host;
    this.ledger = new Ledger(previous?.ledger);
    this.session = previous?.session ?? { id: crypto.randomUUID() };
    for (const [key, literal] of Object.entries(previous?.literals ?? {})) {
      this.literals.set(key, literal);
    }
  }

  recorded(): RecordedScope {
    return {
      ledger: this.ledger.toJSON(),
      literals: Object.fromEntries(this.literals),
      session: this.session,
    };
  }

  literal(path: readonly string[], fresh: Literal): Literal {
    const key = path.join(".");
    const recorded = this.literals.get(key);
    if (recorded) {
      return recorded;
    }
    this.literals.set(key, fresh);
    return fresh;
  }

  attach(root: Step): void {
    this.#root = root;
    root.onAbort((reason) => this.abort(reason));
  }

  get root(): Step {
    if (!this.#root) {
      throw new Error("run scope has no root yet");
    }
    return this.#root;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  stream(signal?: AbortSignal): ReadableStream<ChannelMessage> {
    return this.root.subscribe(signal);
  }

  abort(reason?: unknown): void {
    if (this.controller.signal.aborted) {
      return;
    }
    this.controller.abort(reason ?? new Error("run aborted"));
  }

  frame(path: readonly string[]): Frame {
    const key = path.join(".");
    const existing = this.frames.get(key);
    if (existing) {
      return existing;
    }
    const controller = this.#stepController(path);
    const frame: Frame = {
      controller,
      counters: new Map(),
      detached: [],
      key,
      opened: new Set(),
      path,
      signal: controller.signal,
      work: new StepWork(key),
    };
    this.frames.set(key, frame);
    return frame;
  }

  #stepController(path: readonly string[]): AbortController {
    const controller = new AbortController();
    const propagate = () => controller.abort(this.controller.signal.reason);
    if (this.controller.signal.aborted) {
      propagate();
    } else {
      this.controller.signal.addEventListener("abort", propagate, {
        once: true,
      });
    }
    for (let depth = path.length - 1; depth > 0; depth -= 1) {
      const parent = this.frames.get(path.slice(0, depth).join("."));
      if (!parent) {
        continue;
      }
      if (parent.paused) {
        break;
      }
      const propagateParent = () => controller.abort(parent.signal.reason);
      if (parent.signal.aborted) {
        propagateParent();
      } else {
        parent.signal.addEventListener("abort", propagateParent, {
          once: true,
        });
      }
      break;
    }
    return controller;
  }

  async enter(frame: Frame): Promise<void> {
    frame.counters.clear();
    if (frame.failed) {
      frame.failed = false;
      this.ledger.forget(frame.path);
    }
    frame.paused = undefined;
    if (frame.signal.aborted && !this.controller.signal.aborted) {
      frame.controller = this.#stepController(frame.path);
      frame.signal = frame.controller.signal;
    }
    const ancestor = this.#pausedAncestor(frame);
    if (ancestor) {
      frame.paused = ancestor;
      frame.controller.abort(new Error(ancestor.reason));
    }
    if (frame.detached.length > 0) {
      const pending = frame.detached;
      frame.detached = [];
      await Promise.allSettled(pending);
    }
  }

  #pausedAncestor(frame: Frame): Pause | undefined {
    for (let depth = frame.path.length - 1; depth > 0; depth -= 1) {
      const paused = this.frames.get(
        frame.path.slice(0, depth).join(".")
      )?.paused;
      if (paused) {
        return paused;
      }
    }
    return undefined;
  }

  pause(stepId: string, reason = "paused from the dashboard"): boolean {
    const frames = this.subtree(stepId).filter(
      (frame) => !frame.signal.aborted
    );
    for (const frame of frames) {
      frame.paused = { reason };
    }
    for (const frame of frames) {
      frame.controller.abort(new Error(reason));
    }
    return frames.length > 0;
  }

  pauseName(frame: Frame): string {
    return `${PAUSE_KIND}:${String(this.#answers.get(frame.key)?.length ?? 0)}`;
  }

  offerResumePrompt(frame: Frame): void {
    const answers = this.#answers.get(frame.key) ?? [];
    const taken = this.ledger.get<number>(this.#resumeKey(frame)) ?? 0;
    frame.resumePrompt =
      answers.length > taken ? promptOf(answers.at(-1)) : undefined;
  }

  takeResumePrompt(frame: Frame): string | undefined {
    const prompt = frame.resumePrompt;
    frame.resumePrompt = undefined;
    if (prompt !== undefined) {
      this.ledger.set(
        this.#resumeKey(frame),
        this.#answers.get(frame.key)?.length ?? 0
      );
    }
    return prompt;
  }

  #resumeKey(frame: Frame): string {
    return `${PAUSE_KIND}:${frame.key}`;
  }

  subtree(stepId: string): readonly Frame[] {
    const prefix = `${stepId}.`;
    return [...this.frames.values()].filter(
      (frame) => frame.key === stepId || frame.key.startsWith(prefix)
    );
  }

  steer(stepId: string, prompt: string): void {
    const frame = this.frames.get(stepId);
    if (!frame) {
      throw StepWork.noTurn(stepId);
    }
    frame.work.steer(prompt);
  }

  send(stepId: string, input: StepInput): void {
    const frame = this.frames.get(stepId);
    if (!frame) {
      throw new StepInputError(
        "not-live",
        `"${stepId}" has nothing live in run ${this.id}.`
      );
    }
    frame.work.send(input);
  }

  work(): readonly LiveWork[] {
    return [...this.frames.values()].flatMap((frame) => frame.work.list());
  }

  claim(frame: Frame, kind: string): { key: string; occurrence: number } {
    const occurrence = frame.counters.get(kind) ?? 0;
    frame.counters.set(kind, occurrence + 1);
    return { key: Ledger.key(frame.path, kind, occurrence), occurrence };
  }

  end(): Promise<void> {
    this.#ended ??= (async () => {
      this.abort(new Error(`run ${this.id}'s attempt ended`));
      await Promise.allSettled(
        [...this.frames.values()].flatMap((frame) => frame.detached)
      );
      await this.settle();
    })();
    return this.#ended;
  }

  async settle(): Promise<void> {
    for (const frame of [...this.frames.values()].reverse()) {
      for (const handle of [...frame.opened].reverse()) {
        await Promise.resolve()
          .then(() => handle.close())
          .catch(() => undefined);
      }
      frame.opened.clear();
    }
  }
}

export interface ReadonlyRunScopes extends Iterable<RunScope> {
  get(runId: string): RunScope | undefined;
  has(runId: string): boolean;
  readonly size: number;
}

export class RunScopes implements ReadonlyRunScopes {
  readonly #live = new Map<string, RunScope>();
  readonly #stored: StoredScopes;

  constructor(stored: StoredScopes = () => Promise.resolve(undefined)) {
    this.#stored = stored;
  }

  async open(
    id: string,
    cwd: string,
    host: HostBindings | undefined,
    build: (scope: RunScope) => Promise<Step>,
    resolutions?: Resolutions
  ): Promise<Step> {
    const previous = this.#live.get(id);
    await previous?.end();
    const recorded = (await this.#stored(id)) ?? previous?.recorded();
    const scope = new RunScope(id, cwd, host, recorded, resolutions);
    const root = await build(scope);
    scope.attach(root);
    this.#live.set(id, scope);
    return root;
  }

  get(runId: string): RunScope | undefined {
    return this.#live.get(runId);
  }

  has(runId: string): boolean {
    return this.#live.has(runId);
  }

  get size(): number {
    return this.#live.size;
  }

  async settle(runId: string): Promise<void> {
    await this.#live.get(runId)?.settle();
    this.#live.delete(runId);
  }

  [Symbol.iterator](): IterableIterator<RunScope> {
    return this.#live.values();
  }
}

export function raceAbort<T>(frame: Frame, work: Promise<T>): Promise<T> {
  if (frame.signal.aborted) {
    return Promise.reject(frame.signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(frame.signal.reason);
    frame.signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      frame.signal.removeEventListener("abort", onAbort);
    });
  });
}
