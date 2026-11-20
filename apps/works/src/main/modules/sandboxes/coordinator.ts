import { createHash } from "node:crypto";
import { withConfirmedModuleContainerCleanup } from "@foundry/modules/platform/container-cleanup";
import { MODULE_SETTING_HOST_POLICY } from "@foundry/modules/settings";
import {
  type Container,
  type Containers,
  createContainers,
} from "@foundry/sandbox/container/containers";
import type { ContainerRuntime } from "@foundry/sandbox/container/types";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import type { SandboxResources } from "../settings";
import type { SandboxCapacity, SandboxReservation } from "./capacity";

const MODULE_SANDBOX_RESOURCES: SandboxResources = {
  cpus: MODULE_SETTING_HOST_POLICY["resources.cpus"].default,
  memoryBytes: MODULE_SETTING_HOST_POLICY["resources.memoryBytes"].default,
};
export const MODULE_SANDBOX_ROOT = "/workspace";

export interface ModuleSandboxLoan {
  readonly container: Container;
  readonly moduleId: string;
  release(): void;
  readonly signal: AbortSignal;
}

export interface BorrowOptions {
  readonly signal?: AbortSignal;
  readonly waiting?: () => void;
}

export interface ModuleSandboxesOptions {
  readonly admit?: (moduleId: string) => Promise<void>;
  readonly capacity: SandboxCapacity;
  readonly instance: string;
  readonly memoryBytes?: number;
  readonly resources?: (moduleId: string) => Promise<SandboxResources>;
  readonly runtime: () => Promise<ContainerRuntime>;
}

interface Entry {
  container?: Container;
  drained?: () => void;
  readonly loans: Set<object>;
  readonly ready: Promise<Container>;
  reservation?: SandboxReservation;
  stopped?: Promise<void>;
  readonly stopping: AbortController;
  readonly waiters: Set<() => void>;
  waiting: boolean;
}

export class ModuleSandboxes {
  readonly #admit: (moduleId: string) => Promise<void>;
  readonly #capacity: SandboxCapacity;
  readonly #entries = new Map<string, Entry>();
  readonly #instanceLabel: string;
  readonly #resources: (moduleId: string) => Promise<SandboxResources>;
  readonly #runtime: () => Promise<ContainerRuntime>;
  readonly #closed = new AbortController();
  #prepared: Promise<Containers> | undefined;

  constructor(options: ModuleSandboxesOptions) {
    this.#admit = options.admit ?? (() => Promise.resolve());
    this.#capacity = options.capacity;
    this.#instanceLabel = createHash("sha256")
      .update(`${options.instance}/modules/build`)
      .digest("hex")
      .slice(0, 16);
    const fixed: SandboxResources = {
      ...MODULE_SANDBOX_RESOURCES,
      ...(options.memoryBytes === undefined
        ? {}
        : { memoryBytes: options.memoryBytes }),
    };
    this.#resources = options.resources ?? (() => Promise.resolve(fixed));
    this.#runtime = options.runtime;
  }

  async borrow(
    moduleId: string,
    options: BorrowOptions = {}
  ): Promise<ModuleSandboxLoan> {
    const { signal } = options;
    await this.#admit(moduleId);
    for (;;) {
      if (this.#closed.signal.aborted) {
        throw new Error("Works is shutting down");
      }
      signal?.throwIfAborted();
      const entry = this.#entries.get(moduleId) ?? this.#create(moduleId);
      if (entry.stopping.signal.aborted) {
        if (!entry.stopped) {
          throw new Error(
            "This Module's sandbox did not stop cleanly. Stop the Module again before reusing it."
          );
        }
        await entry.stopped.catch(() => undefined);
        continue;
      }
      const notify = () => options.waiting?.();
      if (entry.waiting) {
        notify();
      }
      entry.waiters.add(notify);
      let container: Container;
      try {
        container = await abortable(entry.ready, signal);
      } finally {
        entry.waiters.delete(notify);
      }
      if (entry.stopping.signal.aborted) {
        continue;
      }
      const token = {};
      entry.loans.add(token);
      return {
        container,
        moduleId,
        release: () => {
          if (entry.loans.delete(token) && entry.loans.size === 0) {
            entry.drained?.();
          }
        },
        signal: entry.stopping.signal,
      };
    }
  }

  live(): readonly string[] {
    return [...this.#entries]
      .filter(([, entry]) => entry.container && !entry.stopping.signal.aborted)
      .map(([moduleId]) => moduleId);
  }

  stop(moduleId: string): Promise<void> {
    const entry = this.#entries.get(moduleId);
    if (!entry) {
      return Promise.resolve();
    }
    entry.stopped ??= this.#stop(moduleId, entry);
    return entry.stopped;
  }

  async shutdown(): Promise<void> {
    this.#closed.abort();
    const results = await Promise.allSettled(
      [...this.#entries.keys()].map((moduleId) => this.stop(moduleId))
    );
    const containers = await this.#prepared?.catch(() => undefined);
    const failures: unknown[] = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    try {
      await containers?.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, "Module sandbox cleanup failed");
    }
  }

  #create(moduleId: string): Entry {
    const ready = Promise.withResolvers<Container>();
    const entry: Entry = {
      loans: new Set(),
      ready: ready.promise,
      stopping: new AbortController(),
      waiters: new Set(),
      waiting: false,
    };
    this.#entries.set(moduleId, entry);
    this.#start(moduleId, entry).then(ready.resolve, (error: unknown) => {
      if (this.#entries.get(moduleId) === entry && !entry.stopped) {
        this.#entries.delete(moduleId);
      }
      ready.reject(error);
    });
    ready.promise.catch(() => undefined);
    return entry;
  }

  async #start(moduleId: string, entry: Entry): Promise<Container> {
    const { signal } = entry.stopping;
    const resources = await this.#resources(moduleId);
    signal.throwIfAborted();
    const reservation = await this.#capacity.acquire(resources.memoryBytes, {
      signal,
      waiting: () => {
        entry.waiting = true;
        for (const waiter of entry.waiters) {
          waiter();
        }
      },
    });
    entry.waiting = false;
    entry.reservation = reservation;
    try {
      const containers = await this.#prepare();
      signal.throwIfAborted();
      entry.container = await containers.start(
        {
          format: "foundry.sandbox.container/1",
          image: "docker.io/oven/bun:1-slim",
          mounts: [],
          network: "unrestricted",
          resources: { ...resources, pids: 256 },
          workdir: MODULE_SANDBOX_ROOT,
        },
        signal
      );
      return entry.container;
    } catch (error) {
      entry.reservation = undefined;
      reservation.release();
      throw error;
    }
  }

  async #stop(moduleId: string, entry: Entry) {
    entry.stopping.abort(new Error("The Module's sandbox is stopping"));
    await entry.ready.catch(() => undefined);
    if (entry.loans.size > 0) {
      await new Promise<void>((resolve) => {
        entry.drained = resolve;
      });
    }
    const { container } = entry;
    if (container) {
      try {
        const containers = await this.#prepare();
        await container.close();
        await containers.remove(container.id);
      } catch (error) {
        entry.stopped = undefined;
        throw error;
      }
    }
    entry.reservation?.release();
    if (this.#entries.get(moduleId) === entry) {
      this.#entries.delete(moduleId);
    }
  }

  #prepare(): Promise<Containers> {
    if (!this.#prepared) {
      const prepared = (async () => {
        const runtime = await this.#runtime();
        if (!(await runtime.isInstalled())) {
          throw new Error(
            "Module builds require the Microsandbox runtime. Install it before building."
          );
        }
        const containers = withConfirmedModuleContainerCleanup(
          createContainers({
            instanceLabel: this.#instanceLabel,
            runtime,
            store: new MemoryContainerStore(),
          }),
          runtime
        );
        await containers.sweep();
        return containers;
      })();
      this.#prepared = prepared;
      prepared.catch(() => {
        if (this.#prepared === prepared) {
          this.#prepared = undefined;
        }
      });
    }
    return this.#prepared;
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}
