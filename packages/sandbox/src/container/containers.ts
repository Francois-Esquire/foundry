import { SandboxError } from "../errors";
import { assertNotAborted } from "../sandbox-adapter";
import type { ContainerStore, ContainerStoreWrite } from "../store/index";
import { MemoryContainerStore } from "../store/memory";
import type { ContainerRow, SandboxEvent } from "../store/schema";
import type { ContainerSandboxConstraints } from "./constraints";
import {
  containerSandboxConfigFromConstraints,
  containerSandboxConstraintsSchema,
} from "./constraints";
import type {
  Container,
  Containers,
  CreateContainersOptions,
} from "./contracts";
import {
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  CONTAINER_STORE_LABEL,
  removeByHand,
} from "./defaults";
import {
  type AttachedContainer,
  attachContainer,
  resolveContainerMountSpecs,
} from "./facets";
import { createInventory, ownsNativeName } from "./inventory";
import type { ContainerConfig } from "./runtime";
import { resolveContainerSpec } from "./spec";

export type {
  Containers,
  CreateContainersOptions,
} from "./contracts";

type RowPatch = Partial<Pick<ContainerRow, "nativeId" | "spec" | "status">>;

interface Live {
  handles: number;
  labels: Readonly<Record<string, string>>;
  nativeId: string;
  row: ContainerRow;
  turn: Promise<void>;
  vm: AttachedContainer;
}

export function createContainers(options: CreateContainersOptions): Containers {
  const { runtime } = options;
  const store = options.store ?? new MemoryContainerStore();
  const holder = options.holder ?? globalThis.crypto.randomUUID();
  const live = new Map<string, Live>();
  const pending = new Map<string, Promise<Live>>();
  const releasing = new Map<string, Promise<void>>();
  const removing = new Set<string>();
  let stopped = false;
  let tail: Promise<unknown> = Promise.resolve();

  const selection = Object.freeze({
    [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
    [CONTAINER_INSTANCE_LABEL]: options.instanceLabel,
  });
  const inventory = createInventory({
    report: options.report,
    runtime,
    selection,
    store,
  });

  const rowOrThrow = async (
    id: string,
    view: ContainerStore = store
  ): Promise<ContainerRow> => {
    const row = await view.get(id);
    if (row === undefined) {
      throw new SandboxError(
        "invalid-contract",
        `container ${id} does not exist`
      );
    }
    return row;
  };

  const serialized = <T>(
    work: (view: ContainerStore) => Promise<T>
  ): Promise<T> => {
    const exclusive = (): Promise<T> =>
      store.transaction === undefined ? work(store) : store.transaction(work);
    const run = tail.then(exclusive, exclusive);
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const update = async (
    entry: { row: ContainerRow },
    patch: RowPatch | ((current: ContainerRow) => RowPatch)
  ): Promise<void> => {
    const eventId = globalThis.crypto.randomUUID();
    entry.row = await serialized(async (view) => {
      const current = await rowOrThrow(entry.row.id, view);
      const next: ContainerRow = Object.freeze({
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
        holder,
        updatedAt: Date.now(),
      });
      const entered = enteredEvent(current, next);
      await commitOwnNames(view, {
        ...(entered === undefined
          ? {}
          : {
              events: [sandboxEvent(entered, eventId, next.id, next.updatedAt)],
            }),
        putContainers: [next],
      });
      return next;
    });
  };

  const alreadyExists = (id: string): SandboxError =>
    new SandboxError("invalid-contract", `container ${id} already exists`);

  const insert = (id: string, constraints: ContainerSandboxConstraints) => {
    const eventId = globalThis.crypto.randomUUID();
    return serialized(async (view): Promise<ContainerRow> => {
      if ((await view.get(id)) !== undefined) {
        throw alreadyExists(id);
      }
      const now = Date.now();
      const row: ContainerRow = Object.freeze({
        createdAt: now,
        holder,
        id,
        nativeId: nextNativeId({ id, nativeId: undefined }),
        spec: JSON.stringify(constraints),
        status: "starting",
        updatedAt: now,
      });
      await commitOwnNames(view, {
        events: [sandboxEvent("sandbox.created", eventId, id, now)],
        putContainers: [row],
      });
      return row;
    });
  };

  const boot = async (
    entry: { row: ContainerRow },
    constraints: ContainerSandboxConstraints,
    signal: AbortSignal | undefined
  ): Promise<Pick<Live, "labels" | "nativeId" | "vm">> => {
    assertNotAborted(signal, "container start was cancelled");
    const { row } = entry;
    const { nativeId } = row;
    if (nativeId === undefined) {
      throw new SandboxError(
        "invalid-transition",
        `container ${row.id} has no native name recorded to boot under`
      );
    }
    const resolved = containerSandboxConfigFromConstraints(
      constraints,
      options.config
    );
    const own = await store.identity();
    const labels = {
      ...resolved.labels,
      ...selection,
      [CONTAINER_ID_LABEL]: row.id,
      [CONTAINER_STORE_LABEL]: own,
    };
    const config: ContainerConfig = { ...resolved, labels, name: nativeId };
    let vm: AttachedContainer | undefined;
    try {
      const mounts = await resolveContainerMountSpecs(
        constraints.mounts ?? [],
        options.allowedMountRoots ?? [],
        options.mountTargetRoot
      );
      const spec = await resolveContainerSpec(config, mounts);
      const instance = await runtime.create(spec);
      vm = attachContainer(instance, spec, {
        mountCapability: (options.allowedMountRoots?.length ?? 0) > 0,
      });
      await instance.ensureDirectory(spec.workdir);
      await update(entry, { status: "running" });
      return { labels, nativeId, vm };
    } catch (error: unknown) {
      if (vm !== undefined) {
        await inventory.discardBooted(
          { labels, name: nativeId },
          row.id,
          own,
          vm
        );
      }
      await update(entry, { status: "failed" }).catch(() => undefined);
      throw error;
    }
  };

  const bringUp = async (
    entry: { row: ContainerRow },
    constraints: ContainerSandboxConstraints,
    signal: AbortSignal | undefined
  ): Promise<Live> => {
    const booted = await boot(entry, constraints, signal);
    const created: Live = {
      ...booted,
      handles: 0,
      row: entry.row,
      turn: Promise.resolve(),
    };
    live.set(entry.row.id, created);
    return created;
  };

  const bringingUp = (id: string, work: () => Promise<Live>): Promise<Live> => {
    const inflight = work().finally(() => pending.delete(id));
    pending.set(id, inflight);
    return inflight;
  };

  const released = (id: string): Promise<void> | undefined =>
    releasing.get(id)?.catch(() => undefined);

  const inReleaseTurn = (
    id: string,
    work: () => Promise<void>
  ): Promise<void> => {
    const prior = released(id);
    const done: Promise<void> = (async () => {
      await prior;
      await work();
    })().finally(() => {
      if (releasing.get(id) === done) {
        releasing.delete(id);
      }
    });
    releasing.set(id, done);
    return done;
  };

  const release = (entry: Live): Promise<void> => {
    live.delete(entry.row.id);
    return inReleaseTurn(entry.row.id, async () => {
      await entry.turn;
      await inventory.removeAttached(entry.row.id, entry, "close");
      await update(entry, { status: "stopped" });
    });
  };

  const retryRelease = async (id: string): Promise<void> => {
    if (live.has(id) || pending.has(id) || removing.has(id)) {
      return;
    }
    await inReleaseTurn(id, async () => {
      if ((await store.get(id)) !== undefined) {
        await stopRow(id);
      }
    });
  };

  const handleFor = (entry: Live): Container => {
    entry.handles += 1;
    let closing: Promise<void> | undefined;
    let failed = false;
    const letGo = async (): Promise<void> => {
      if (failed) {
        await retryRelease(entry.row.id);
        return;
      }
      entry.handles -= 1;
      if (entry.handles === 0 && live.get(entry.row.id) === entry) {
        await release(entry);
      }
    };
    return Object.freeze({
      close() {
        closing ??= letGo().catch((error: unknown) => {
          failed = true;
          closing = undefined;
          throw error;
        });
        return closing;
      },
      get commands() {
        return entry.vm.facets.commands;
      },
      get files() {
        return entry.vm.facets.files;
      },
      id: entry.row.id,
      get ports() {
        return entry.vm.facets.ports;
      },
      get processes() {
        return entry.vm.facets.processes;
      },
      get row() {
        return entry.row;
      },
      get services() {
        return entry.vm.facets.services;
      },
      get shell() {
        return entry.vm.facets.shell;
      },
      get volumes() {
        return entry.vm.facets.volumes;
      },
      get workingDirectory() {
        return entry.vm.facets.workingDirectory;
      },
    });
  };

  const assertNotRemoving = (id: string): void => {
    if (removing.has(id)) {
      throw new SandboxError(
        "invalid-transition",
        `container ${id} is being removed`
      );
    }
  };

  const assertNotClaimedElsewhere = (row: ContainerRow): void => {
    if (row.status === "removing" && row.holder !== holder) {
      throw new SandboxError(
        "invalid-transition",
        `container ${row.id} is being removed`
      );
    }
  };

  const assertOpen = (): void => {
    if (stopped) {
      throw new SandboxError("invalid-transition", "containers have shut down");
    }
  };

  const claimForRemoval = (
    id: string,
    judged?: ContainerRow
  ): Promise<ContainerRow | undefined> =>
    serialized(async (view) => {
      const current = await view.get(id);
      if (
        current === undefined ||
        (judged !== undefined &&
          (current.holder !== judged.holder ||
            current.updatedAt !== judged.updatedAt))
      ) {
        return;
      }
      const claimed: ContainerRow = Object.freeze({
        ...current,
        holder,
        status: "removing",
        updatedAt: Date.now(),
      });
      await commitOwnNames(view, { putContainers: [claimed] });
      return claimed;
    });

  const deleteHeld = (id: string): Promise<void> => {
    const eventId = globalThis.crypto.randomUUID();
    return serialized(async (view) => {
      if ((await view.get(id))?.holder === holder) {
        await view.commit({
          deleteContainers: [id],
          events: [sandboxEvent("sandbox.destroyed", eventId, id, Date.now())],
        });
      }
    });
  };

  const removeClaimed = async (
    row: ContainerRow
  ): Promise<{
    readonly conflicts: readonly string[];
    readonly removed: boolean;
  }> => {
    const { conflicts, stuck, unjudged } = await inventory.clearRow(row);
    const removed = !unjudged && conflicts.length === 0 && stuck.length === 0;
    if (removed) {
      await deleteHeld(row.id);
    }
    return { conflicts, removed };
  };

  const stopRow = async (id: string): Promise<void> => {
    const row = await rowOrThrow(id);
    assertNotClaimedElsewhere(row);
    const { conflicts, stuck, unjudged } = await inventory.clearRow(row);
    if (unjudged) {
      if (row.nativeId !== undefined) {
        inventory.retryByName(row.nativeId, id);
      }
      throw new SandboxError(
        "provider-failed",
        `container ${id}: its VMs could not be judged; stop it again to retry`
      );
    }
    if (stuck.length > 0) {
      await inventory.retryStuck(stuck, id);
    }
    if (conflicts.length > 0) {
      throw new SandboxError(
        "invalid-contract",
        `container ${id}: the VM(s) ${conflicts.join(", ")} carry its id or name but are not provably its own, so they are left; remove them by hand with ${conflicts.map(removeByHand).join(", ")}`
      );
    }
    if (stuck.length > 0) {
      throw new SandboxError(
        "provider-failed",
        `container ${id}: the VM(s) ${stuck.map((each) => each.name).join(", ")} could not be removed; stop it again to retry`
      );
    }
    await update({ row }, (current) => {
      assertNotClaimedElsewhere(current);
      return current.nativeId === row.nativeId && BOOTED.has(current.status)
        ? { status: "stopped" }
        : {};
    });
  };

  const containers: Containers = {
    get: (id) => store.get(id),

    list: () => store.list(),

    async open(id, signal) {
      assertOpen();
      const running = live.get(id);
      if (running !== undefined) {
        return handleFor(running);
      }
      let inflight = pending.get(id);
      if (inflight === undefined) {
        assertNotRemoving(id);
        inflight = bringingUp(id, async () => {
          await released(id);
          let previous: string | undefined;
          const row = await serialized(async (view) => {
            const current = await rowOrThrow(id, view);
            assertNotClaimedElsewhere(current);
            previous = current.nativeId;
            const claimed: ContainerRow = Object.freeze({
              ...current,
              holder,
              nativeId: nextNativeId(current),
              status: "starting",
              updatedAt: Date.now(),
            });
            await commitOwnNames(view, { putContainers: [claimed] });
            return claimed;
          });
          if (previous !== undefined) {
            await inventory.removeSuperseded(previous, id);
          }
          return bringUp({ row }, parseSpec(JSON.parse(row.spec)), signal);
        });
      }
      return handleFor(await inflight);
    },

    async recover(left, signal) {
      assertOpen();
      const removed: string[] = [];
      const kept: string[] = [];
      const conflicts: string[] = [];
      for (const row of await store.list()) {
        assertNotAborted(signal, "container recovery was cancelled");
        const { id } = row;
        if (
          live.has(id) ||
          pending.has(id) ||
          removing.has(id) ||
          !(await left(row))
        ) {
          continue;
        }
        removing.add(id);
        try {
          const claimed = await claimForRemoval(id, row);
          if (claimed !== undefined) {
            const taken = await removeClaimed(claimed);
            (taken.removed ? removed : kept).push(id);
            conflicts.push(...taken.conflicts);
          }
        } finally {
          removing.delete(id);
        }
      }
      const swept = await containers.sweep(signal);
      return Object.freeze({
        conflicts: Object.freeze(conflicts),
        kept: Object.freeze(kept),
        passedOver: swept.passedOver,
        removed: Object.freeze(removed),
        swept: Object.freeze([...swept]),
      });
    },

    async remove(id) {
      assertOpen();
      if (live.has(id) || pending.has(id)) {
        throw new SandboxError(
          "invalid-transition",
          `container ${id} is live; close every handle before removing it`
        );
      }
      assertNotRemoving(id);
      removing.add(id);
      try {
        await released(id);
        const claimed = await claimForRemoval(id);
        if (claimed === undefined) {
          throw new SandboxError(
            "invalid-contract",
            `container ${id} does not exist`
          );
        }
        const taken = await removeClaimed(claimed);
        if (taken.conflicts.length > 0) {
          throw new SandboxError(
            "invalid-contract",
            `container ${id}: the VM(s) ${taken.conflicts.join(", ")} carry its id but another row records them; left alone, the row is kept, removing`
          );
        }
        if (!taken.removed) {
          throw new SandboxError(
            "provider-failed",
            `container ${id}: its VM ${String(claimed.nativeId)} could not be removed; the row is kept to retry`
          );
        }
      } finally {
        removing.delete(id);
      }
    },

    async restart(id, spec, signal) {
      assertOpen();
      const entry = live.get(id);
      if (entry === undefined) {
        assertNotRemoving(id);
        const row = await rowOrThrow(id);
        assertNotClaimedElsewhere(row);
        if (spec !== undefined) {
          const recorded = JSON.stringify(parseSpec(spec));
          await update({ row }, (current) => {
            assertNotClaimedElsewhere(current);
            return { spec: recorded };
          });
        }
        return;
      }
      const given = spec === undefined ? undefined : parseSpec(spec);
      const assertStillLive = (): void => {
        if (live.get(id) !== entry) {
          throw new SandboxError(
            "invalid-transition",
            `container ${id} was closed before its restart finished`
          );
        }
      };
      const run = async (): Promise<void> => {
        assertStillLive();
        const constraints = given ?? parseSpec(JSON.parse(entry.row.spec));
        await update(entry, {
          status: "restarting",
          ...(given === undefined ? {} : { spec: JSON.stringify(given) }),
        });
        try {
          await inventory.removeAttached(entry.row.id, entry, "restart");
          assertStillLive();
          await update(entry, (current) => ({
            nativeId: nextNativeId(current),
          }));
          assertStillLive();
          const booted = await boot(entry, constraints, signal);
          entry.vm = booted.vm;
          entry.nativeId = booted.nativeId;
          entry.labels = booted.labels;
          assertStillLive();
        } catch (error: unknown) {
          if (live.get(id) === entry) {
            live.delete(id);
            if (entry.row.status === "restarting") {
              await update(entry, { status: "failed" }).catch(() => undefined);
            }
          }
          throw error;
        }
      };
      const turn = entry.turn.then(run, run);
      entry.turn = turn.catch(() => undefined);
      await turn;
    },

    async shutdown() {
      let releases: PromiseSettledResult<void>[] = [];
      if (!stopped) {
        stopped = true;
        await Promise.allSettled([...pending.values(), ...releasing.values()]);
        releases = await Promise.allSettled([...live.values()].map(release));
      }
      await inventory.retryAtShutdown();
      const failed = releases.find((result) => result.status === "rejected");
      if (failed !== undefined) {
        throw failed.reason;
      }
    },

    async start(spec, signal) {
      assertOpen();
      const constraints = parseSpec(spec);
      const id = globalThis.crypto.randomUUID();
      if (live.has(id) || pending.has(id)) {
        throw alreadyExists(id);
      }
      const booted = await bringingUp(id, async () => {
        const row = await insert(id, constraints);
        return await bringUp({ row }, constraints, signal);
      });
      return handleFor(booted);
    },
    async stop(id) {
      assertOpen();
      if (live.has(id) || pending.has(id)) {
        throw new SandboxError(
          "invalid-transition",
          `container ${id} is live; close every handle before stopping it`
        );
      }
      assertNotRemoving(id);
      await inReleaseTurn(id, () => stopRow(id));
    },

    async sweep(signal) {
      assertOpen();
      return await inventory.sweep(signal);
    },
  };
  return Object.freeze(containers);
}

function enteredEvent(
  current: ContainerRow,
  next: ContainerRow
): SandboxEvent["type"] | undefined {
  if (next.status === current.status) {
    return;
  }
  return ENTERED[next.status];
}

const ENTERED: Partial<Record<ContainerRow["status"], SandboxEvent["type"]>> = {
  failed: "sandbox.failed",
  running: "sandbox.started",
  stopped: "sandbox.stopped",
};

function sandboxEvent(
  type: SandboxEvent["type"],
  id: string,
  containerId: string,
  at: number
): SandboxEvent {
  return { at: new Date(at).toISOString(), containerId, id, type };
}

function parseSpec(input: unknown): ContainerSandboxConstraints {
  const result = containerSandboxConstraintsSchema.safeParse(input);
  if (!result.success) {
    throw new SandboxError(
      "invalid-contract",
      `invalid container spec: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return Object.freeze(result.data);
}

const BOOTED: ReadonlySet<ContainerRow["status"]> = new Set([
  "restarting",
  "running",
  "starting",
]);

async function commitOwnNames(
  view: ContainerStore,
  write: ContainerStoreWrite
): Promise<void> {
  const foreign = write.putContainers?.find(
    (row) => row.nativeId !== undefined && !ownsNativeName(row.id, row.nativeId)
  );
  if (foreign !== undefined) {
    throw new SandboxError(
      "invalid-contract",
      `container ${foreign.id} records the native name ${String(foreign.nativeId)}, which is not one of its own`
    );
  }
  await view.commit(write);
}

function nextNativeId(row: Pick<ContainerRow, "id" | "nativeId">): string {
  const previous = Number.parseInt(
    row.nativeId?.slice(row.id.length + 1) ?? "0",
    10
  );
  const generation = (Number.isNaN(previous) ? 0 : previous) + 1;
  return `${row.id}-${String(generation)}`;
}
