import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelMessage } from "@foundry/workflows/channels";
import type { Step } from "@foundry/workflows/step";

import { Ledger } from "./ledger";
import type { SessionRef } from "./types";

/**
 * One RunScope per run, created by the definition's factory. It owns the
 * run-level abort controller, the frame table, the ledger, and the run's
 * session reference. Frames are per step path; each has its own controller
 * chained under the run's. Bodies find their frame through async context,
 * which is also how a worktree callback narrows the working directory.
 */

export interface Closable {
  close(): Promise<void> | void;
}

export interface Frame {
  readonly controller: AbortController;
  /** Per-kind call counters, reset when the body (re)enters. */
  readonly counters: Map<string, number>;
  /** Children still running after this frame parked; awaited on re-entry. */
  detached: readonly Promise<unknown>[];
  readonly key: string;
  readonly opened: Set<Closable>;
  readonly path: readonly string[];
  readonly signal: AbortSignal;
}

export interface Current {
  readonly cwd: string;
  readonly frame: Frame;
  readonly scope: RunScope;
}

export const current = new AsyncLocalStorage<Current>();

/** Every live run in this process, for hosts that steer or inspect. */
export const runs = new Map<string, RunScope>();

export class RunScope {
  readonly controller = new AbortController();
  /** The config's directory. */
  readonly cwd: string;
  readonly frames = new Map<string, Frame>();
  readonly id: string;
  readonly ledger = new Ledger();
  readonly session: SessionRef;
  #root: Step | undefined;

  constructor(id: string, cwd: string) {
    this.id = id;
    this.cwd = cwd;
    this.session = { id: crypto.randomUUID() };
    runs.set(id, this);
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
    const controller = new AbortController();
    const propagate = () => controller.abort(this.controller.signal.reason);
    if (this.controller.signal.aborted) {
      propagate();
    } else {
      this.controller.signal.addEventListener("abort", propagate, {
        once: true,
      });
    }
    const frame: Frame = {
      controller,
      counters: new Map(),
      detached: [],
      key,
      opened: new Set(),
      path,
      signal: controller.signal,
    };
    this.frames.set(key, frame);
    return frame;
  }

  /** Called when a body starts an attempt: counters restart, stragglers settle. */
  async enter(frame: Frame): Promise<void> {
    frame.counters.clear();
    if (frame.detached.length > 0) {
      const pending = frame.detached;
      frame.detached = [];
      await Promise.allSettled(pending);
    }
  }

  /** The n-th call of `kind` in this frame's current attempt, and its ledger key. */
  claim(frame: Frame, kind: string): { key: string; occurrence: number } {
    const occurrence = frame.counters.get(kind) ?? 0;
    frame.counters.set(kind, occurrence + 1);
    return { key: Ledger.key(frame.path, kind, occurrence), occurrence };
  }

  /** Close everything the run opened and forget the run. */
  async settle(): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const frame of this.frames.values()) {
      for (const handle of frame.opened) {
        closing.push(Promise.resolve().then(() => handle.close()));
      }
      frame.opened.clear();
    }
    await Promise.allSettled(closing);
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

/** The frame a manager call is running in. */
export function requireCurrent(what: string): Current {
  const store = current.getStore();
  if (!store) {
    throw new Error(`${what} can only be called inside a running step`);
  }
  return store;
}
