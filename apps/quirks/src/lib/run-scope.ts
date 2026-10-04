import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelMessage } from "@foundry/workflows/channels";
import type { Step } from "@foundry/workflows/step";

import type { HostBindings } from "./bindings";
import { Ledger } from "./ledger";
import type { SessionRef } from "./types";

/**
 * One RunScope per run, created by the definition's factory. It owns the
 * run-level abort controller, the frame table, the ledger, and the run's
 * session reference. Frames are per step path; each has its own controller
 * chained under the run's. Bodies find their frame through async context,
 * which is also how a worktree callback narrows the working directory.
 */

interface Closable {
  close(): Promise<void> | void;
}

/** An agent session a step opened, and the turn it has in flight. */
export interface LiveSession {
  readonly ref: SessionRef;
  /** A prompt a host handed in mid-turn; the next turn sends it. */
  steer?: string;
  /** The controller of the turn running now, if one is. */
  turn?: AbortController;
}

/** Why a step is parked; a host asked for it. */
interface Pause {
  readonly reason: string;
}

/** The Suspension kind a paused step parks under; the feed never sees it. */
export const PAUSE_KIND = "quirks.pause";

export interface Frame {
  /** Reissued when the body re-enters after a pause. */
  controller: AbortController;
  /** Per-kind call counters, reset when the body (re)enters. */
  readonly counters: Map<string, number>;
  /** Children still running after this frame parked; awaited on re-entry. */
  detached: readonly Promise<unknown>[];
  readonly key: string;
  readonly opened: Set<Closable>;
  readonly path: readonly string[];
  /** Set by `pause`, read once by the body wrapper as it turns the abort into a suspension. */
  paused?: Pause;
  /** A prompt given on resume; the first turn of a recorded session takes it. */
  resumePrompt?: string;
  readonly sessions: LiveSession[];
  signal: AbortSignal;
}

export interface Current {
  readonly cwd: string;
  readonly frame: Frame;
  readonly scope: RunScope;
}

export const current = new AsyncLocalStorage<Current>();

/** Every live run in this process, for hosts that steer or inspect. */
export const runs = new Map<string, RunScope>();

type Literal = Readonly<Record<string, unknown>>;

/** What a parked run recorded before this process; consumed when its scope is rebuilt. */
export interface RestoredScope {
  readonly ledger: Readonly<Record<string, unknown>>;
  /** Each node's literal input by step path, as locked when the run started. */
  readonly literals?: Readonly<Record<string, Literal>>;
  readonly session: SessionRef;
}

const restored = new Map<string, RestoredScope>();

/** The engine hands over a recovered run's state before the Orchestrator rebuilds it. */
export function restoreScope(runId: string, state: RestoredScope): void {
  restored.set(runId, state);
}

export class RunScope {
  readonly controller = new AbortController();
  /** The config's directory. */
  readonly cwd: string;
  readonly frames = new Map<string, Frame>();
  /** Host-only facilities for built-in bodies; authored code never sees them. */
  readonly host: HostBindings;
  readonly id: string;
  readonly ledger: Ledger;
  /** Literal input by step path: recorded when the tree is first built, replayed on recovery. */
  readonly literals = new Map<string, Literal>();
  readonly session: SessionRef;
  #root: Step | undefined;

  constructor(id: string, cwd: string, host: HostBindings = {}) {
    this.id = id;
    this.cwd = cwd;
    this.host = host;
    const previous = restored.get(id);
    restored.delete(id);
    this.ledger = new Ledger(previous?.ledger);
    this.session = previous?.session ?? { id: crypto.randomUUID() };
    for (const [key, literal] of Object.entries(previous?.literals ?? {})) {
      this.literals.set(key, literal);
    }
    runs.set(id, this);
  }

  /**
   * The literal a node runs with. A recovered run keeps the input each
   * node was locked with when it started, so a setup that computes values,
   * or a config edited in between, does not change a step mid-run. A node
   * without a record (new since the run started) takes and records `fresh`.
   */
  literal(path: readonly string[], fresh: Literal): Literal {
    const key = path.join(".");
    const recorded = this.literals.get(key);
    if (recorded) {
      return recorded;
    }
    this.literals.set(key, fresh);
    return fresh;
  }

  /** Bind the root once materialized; package cancellation reaches the run layer. */
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

  /** A fresh subscription to the whole run's events and chunks. */
  stream(signal?: AbortSignal): ReadableStream<ChannelMessage> {
    return this.root.subscribe(signal);
  }

  /** The complete escape: fails the run and aborts everything in it. */
  abort(reason?: unknown): void {
    if (this.controller.signal.aborted) {
      return;
    }
    this.controller.abort(reason ?? new Error("run aborted"));
  }

  /** The frame for a step path, created on first sight. */
  frame(path: readonly string[]): Frame {
    const key = path.join(".");
    const existing = this.frames.get(key);
    if (existing) {
      return existing;
    }
    const controller = this.#stepController();
    const frame: Frame = {
      controller,
      counters: new Map(),
      detached: [],
      key,
      opened: new Set(),
      path,
      sessions: [],
      signal: controller.signal,
    };
    this.frames.set(key, frame);
    return frame;
  }

  /** A step controller chained under the run's. */
  #stepController(): AbortController {
    const controller = new AbortController();
    const propagate = () => controller.abort(this.controller.signal.reason);
    if (this.controller.signal.aborted) {
      propagate();
    } else {
      this.controller.signal.addEventListener("abort", propagate, {
        once: true,
      });
    }
    return controller;
  }

  /**
   * Called when a body starts an attempt: counters restart, a pause that
   * parked this frame is consumed, stragglers settle, and a controller spent
   * by a pause is replaced so the body can run again. A real abort is never
   * replaced: the run's signal still fires. A step entering under an
   * ancestor that is still paused parks at once, so a subtree pause holds
   * for steps that had not started when it was requested.
   */
  async enter(frame: Frame): Promise<void> {
    frame.counters.clear();
    frame.paused = undefined;
    if (frame.signal.aborted && !this.controller.signal.aborted) {
      frame.controller = this.#stepController();
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

  /**
   * Park a step and everything under it: each live frame in the subtree has
   * its signal aborted, which stops what it opened, and its body wrapper
   * records a suspension instead of a failure. `false` when nothing in that
   * subtree is running in this run.
   */
  pause(stepId: string, reason = "paused from the dashboard"): boolean {
    let parked = false;
    for (const frame of this.subtree(stepId)) {
      if (frame.signal.aborted) {
        continue;
      }
      frame.paused = { reason };
      frame.controller.abort(new Error(reason));
      parked = true;
    }
    return parked;
  }

  /** The frame at `stepId` and every frame beneath it. */
  subtree(stepId: string): readonly Frame[] {
    const prefix = `${stepId}.`;
    return [...this.frames.values()].filter(
      (frame) => frame.key === stepId || frame.key.startsWith(prefix)
    );
  }

  /**
   * Hand a prompt to the agent active in a step: its current turn stops and
   * the prompt becomes the next user message. Throws when no turn is running.
   */
  steer(stepId: string, prompt: string): void {
    const frame = this.frames.get(stepId);
    const live = frame?.sessions.find((session) => session.turn !== undefined);
    if (!(frame && live?.turn)) {
      throw new Error(`no agent turn is running in "${stepId}"`);
    }
    live.steer = prompt;
    live.turn.abort(new Error("steered"));
  }

  /** The n-th call of `kind` in this frame's current attempt, and its ledger key. */
  claim(frame: Frame, kind: string): { key: string; occurrence: number } {
    const occurrence = frame.counters.get(kind) ?? 0;
    frame.counters.set(kind, occurrence + 1);
    return { key: Ledger.key(frame.path, kind, occurrence), occurrence };
  }

  /** Close everything the run opened and forget the run. */
  async settle(): Promise<void> {
    for (const frame of [...this.frames.values()].reverse()) {
      for (const handle of [...frame.opened].reverse()) {
        // Sessions are opened after their VM. Commit their terminal transcript
        // before removing the environment that owns their live process.
        await Promise.resolve()
          .then(() => handle.close())
          .catch(() => undefined);
      }
      frame.opened.clear();
    }
    runs.delete(this.id);
  }
}

/** Reject when the frame aborts, so a body cannot outlive its cancellation. */
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
