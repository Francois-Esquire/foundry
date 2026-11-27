import { SandboxError } from "../errors";
import { assertNotAborted } from "../sandbox-adapter";
import type { ContainerStore } from "../store/index";
import { MemoryContainerStore } from "../store/memory";
import type { ContainerRow, SandboxEvent } from "../store/schema";
import type {
  Container,
  ContainerQuery,
  Containers,
  CreateContainersOptions,
} from "./contracts";
import {
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  CONTAINER_STORE_LABEL,
} from "./defaults";
import type { ContainerSpec } from "./driver";
import { type AttachedContainer, attachContainer } from "./facets";
import { createInventory, isForeignNativeName } from "./inventory";
import {
  assertDriverSupports,
  type ContainerSpecInput,
  parseContainerSpecInput,
  resolveContainerSpec,
} from "./spec";

type RowPatch = Partial<Pick<ContainerRow, "nativeId" | "spec" | "status">>;

interface Live {
  handles: number;
  labels: Readonly<Record<string, string>>;
  nativeId: string;
  row: ContainerRow;
  spec: ContainerSpec;
  turn: Promise<void>;
  vm: AttachedContainer;
}

export function createContainers(options: CreateContainersOptions): Containers {
  const { driver } = options;
  const store = options.store ?? new MemoryContainerStore();
  const holder = options.holder ?? globalThis.crypto.randomUUID();
  const capabilities = Object.freeze({ ...driver.capabilities });
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
    driver,
    report: options.report,
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
      if (
        next.nativeId !== undefined &&
        isForeignNativeName(next.id, next.nativeId)
      ) {
        throw new SandboxError(
          "invalid-contract",
          `container ${next.id} records the native name ${next.nativeId}, which is not one of its own`
        );
      }
      await view.commit({
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

  const insert = (id: string, input: ContainerSpecInput) => {
    const eventId = globalThis.crypto.randomUUID();
    return serialized(async (view): Promise<ContainerRow> => {
      if ((await view.get(id)) !== undefined) {
        throw new SandboxError(
          "invalid-contract",
          `container ${id} already exists`
        );
      }
      const now = Date.now();
      const row: ContainerRow = Object.freeze({
        createdAt: now,
        holder,
        id,
        nativeId: nextNativeName({ id, nativeId: undefined }),
        spec: JSON.stringify(input),
        status: "starting",
        updatedAt: now,
      });
      await view.commit({
        events: [sandboxEvent("sandbox.created", eventId, id, now)],
        putContainers: [row],
      });
      return row;
    });
  };

  const buildSpec = async (
    row: ContainerRow,
    input: ContainerSpecInput,
    name: string
  ): Promise<{
    readonly labels: Readonly<Record<string, string>>;
    readonly own: string;
    readonly spec: ContainerSpec;
  }> => {
    const own = await store.identity();
    const labels = Object.freeze({
      ...selection,
      [CONTAINER_ID_LABEL]: row.id,
      [CONTAINER_STORE_LABEL]: own,
    });
    const spec = resolveContainerSpec({
      ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
      input,
      labels,
      ...(options.mountTargetRoot === undefined
        ? {}
        : { mountTargetRoot: options.mountTargetRoot }),
      name,
    });
    assertDriverSupports(spec, driver.capabilities);
    return { labels: spec.labels, own, spec };
  };

  const boot = async (
    entry: { row: ContainerRow },
    input: ContainerSpecInput,
    signal: AbortSignal | undefined
  ): Promise<Pick<Live, "labels" | "nativeId" | "spec" | "vm">> => {
    assertNotAborted(signal, "container start was cancelled");
    const { row } = entry;
    const requestedName = row.nativeId ?? nextNativeName(row);
    let labels: Readonly<Record<string, string>> = {};
    let own = "";
    let vm: AttachedContainer | undefined;
    let actualRef = requestedName;
    try {
      const built = await buildSpec(row, input, requestedName);
      ({ labels, own } = built);
      const { spec } = built;
      const handle = await driver.create(
        {
          containerId: row.id,
          labels,
          name: requestedName,
          spec,
        },
        signal
      );
      actualRef = handle.id;
      vm = attachContainer(handle, spec, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (actualRef !== requestedName) {
        await update(entry, { nativeId: actualRef });
      }
      await handle.ensureDirectory(spec.workdir);
      await update(entry, { nativeId: actualRef, status: "running" });
      return { labels, nativeId: actualRef, spec, vm };
    } catch (error: unknown) {
      if (vm !== undefined) {
        await inventory.discardBooted(
          { labels, name: actualRef },
          row.id,
          own,
          vm
        );
      }
      await update(entry, { status: "failed" }).catch(() => undefined);
      throw error;
    }
  };

  const tryReconnect = async (
    row: ContainerRow,
    input: ContainerSpecInput,
    signal: AbortSignal | undefined
  ): Promise<Live | undefined> => {
    if (
      driver.connect === undefined ||
      row.nativeId === undefined ||
      (row.status !== "running" && row.status !== "paused")
    ) {
      return undefined;
    }
    assertNotAborted(signal, "container open was cancelled");
    if (await inventory.isForeignReference(row.id, row.nativeId)) {
      throw new SandboxError(
        "invalid-contract",
        `container ${row.id} records resource ${row.nativeId}, which is owned by another record`
      );
    }
    const { labels, spec } = await buildSpec(row, input, row.nativeId);
    if (row.status === "paused" && driver.resumeResource !== undefined) {
      await driver.resumeResource(row.nativeId);
    }
    const handle = await driver.connect(row.nativeId, spec, signal);
    if (handle === undefined) {
      return undefined;
    }
    if (row.status === "paused" && handle.resume !== undefined) {
      await handle.resume();
    }
    const vm = attachContainer(handle, spec, {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const eventId = globalThis.crypto.randomUUID();
    let claimed: ContainerRow;
    try {
      claimed = await serialized(async (view) => {
        const current = await view.get(row.id);
        if (
          current === undefined ||
          current.status !== row.status ||
          current.nativeId !== row.nativeId ||
          current.updatedAt !== row.updatedAt
        ) {
          throw new SandboxError(
            "invalid-transition",
            `container ${row.id} changed while reconnecting`
          );
        }
        assertNotClaimedElsewhere(current);
        const next: ContainerRow = Object.freeze({
          ...current,
          holder,
          nativeId: handle.id,
          status: "running",
          updatedAt: Date.now(),
        });
        if (isForeignNativeName(next.id, handle.id)) {
          throw new SandboxError(
            "invalid-contract",
            `container ${next.id} records the native name ${handle.id}, which is not one of its own`
          );
        }
        const entered = enteredEvent(current, next);
        await view.commit({
          ...(entered === undefined
            ? {}
            : {
                events: [
                  sandboxEvent(entered, eventId, next.id, next.updatedAt),
                ],
              }),
          putContainers: [next],
        });
        return next;
      });
    } catch (error: unknown) {
      await vm.disconnect().catch(() => undefined);
      throw error;
    }
    const attached: Live = {
      handles: 0,
      labels,
      nativeId: handle.id,
      row: claimed,
      spec,
      turn: Promise.resolve(),
      vm,
    };
    live.set(row.id, attached);
    return attached;
  };

  const bringUp = async (
    entry: { row: ContainerRow },
    input: ContainerSpecInput,
    signal: AbortSignal | undefined
  ): Promise<Live> => {
    const booted = await boot(entry, input, signal);
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
    const keepOnRelease = entry.spec.lifetime?.whenReleased === "keep";
    return inReleaseTurn(entry.row.id, async () => {
      await entry.turn;
      if (keepOnRelease) {
        await entry.vm.disconnect();
        return;
      }
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
        if (entry.spec.lifetime?.whenReleased === "keep") {
          await inReleaseTurn(entry.row.id, () => entry.vm.disconnect());
          return;
        }
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
      get storage() {
        return entry.vm.facets.storage;
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
      await view.commit({ putContainers: [claimed] });
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
        `container ${id}: its resources could not be checked; stop it again to retry`
      );
    }
    if (stuck.length > 0) {
      await inventory.retryStuck(stuck, id);
    }
    if (conflicts.length > 0) {
      throw new SandboxError(
        "invalid-contract",
        `container ${id}: resources ${conflicts.join(", ")} are not provably owned by this store, so they were left alone (${conflicts.map(inventory.hint).join(", ")})`
      );
    }
    if (stuck.length > 0) {
      throw new SandboxError(
        "provider-failed",
        `container ${id}: resources ${stuck.map((each) => each.name).join(", ")} could not be removed; stop it again to retry`
      );
    }
    await update({ row }, (current) => {
      assertNotClaimedElsewhere(current);
      return current.nativeId === row.nativeId &&
        ACTIVE_STATUSES.has(current.status)
        ? { status: "stopped" }
        : {};
    });
  };

  const containers: Containers = {
    capabilities,

    get: (id) => store.get(id),

    async list(query?: ContainerQuery) {
      const rows = await store.list();
      if (query === undefined) {
        return rows;
      }
      const statuses =
        query.status === undefined
          ? undefined
          : new Set(
              Array.isArray(query.status) ? query.status : [query.status]
            );
      return Object.freeze(
        rows.filter((row) => {
          if (statuses !== undefined && !statuses.has(row.status)) {
            return false;
          }
          if (query.holder !== undefined && row.holder !== query.holder) {
            return false;
          }
          return true;
        })
      );
    },

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
          const existing = await rowOrThrow(id);
          assertNotClaimedElsewhere(existing);
          const parsed = parseContainerSpecInput(JSON.parse(existing.spec));
          const reconnected = await tryReconnect(existing, parsed, signal);
          if (reconnected !== undefined) {
            return reconnected;
          }
          let previous: string | undefined;
          const row = await serialized(async (view) => {
            const current = await rowOrThrow(id, view);
            assertNotClaimedElsewhere(current);
            previous = current.nativeId;
            const claimed: ContainerRow = Object.freeze({
              ...current,
              holder,
              nativeId: nextNativeName(current),
              status: "starting",
              updatedAt: Date.now(),
            });
            await view.commit({ putContainers: [claimed] });
            return claimed;
          });
          if (previous !== undefined) {
            await inventory.removeSuperseded(previous, id);
          }
          return bringUp({ row }, parsed, signal);
        });
      }
      return handleFor(await inflight);
    },

    async pause(id) {
      assertOpen();
      const canPause =
        driver.capabilities?.pause === true ||
        driver.pauseResource !== undefined ||
        live.get(id)?.vm.handle.pause !== undefined;
      if (!canPause) {
        throw new SandboxError(
          "unsupported",
          "driver does not support pausing containers"
        );
      }
      const entry = live.get(id);
      if (entry !== undefined) {
        const run = async (): Promise<void> => {
          if (live.get(id) !== entry) {
            throw new SandboxError(
              "invalid-transition",
              `container ${id} was closed before it could be paused`
            );
          }
          if (entry.vm.handle.pause !== undefined) {
            await entry.vm.handle.pause();
          } else if (driver.pauseResource === undefined) {
            throw new SandboxError(
              "unsupported",
              "driver does not support pausing live containers"
            );
          } else {
            await driver.pauseResource(entry.nativeId);
          }
          await entry.vm.disconnect();
          if (live.get(id) !== entry) {
            return;
          }
          live.delete(id);
          await update(entry, { status: "paused" });
        };
        const turn = entry.turn.then(run, run);
        entry.turn = turn.catch(() => undefined);
        await turn;
        return;
      }
      const row = await rowOrThrow(id);
      assertNotClaimedElsewhere(row);
      if (row.status !== "running" || row.nativeId === undefined) {
        throw new SandboxError(
          "invalid-transition",
          `container ${id} is ${row.status} and cannot be paused`
        );
      }
      if (driver.pauseResource === undefined) {
        throw new SandboxError(
          "unsupported",
          "driver does not support pausing detached containers"
        );
      }
      await driver.pauseResource(row.nativeId);
      await update({ row }, { status: "paused" });
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
            `container ${id}: resources ${taken.conflicts.join(", ")} are owned by another record; left alone`
          );
        }
        if (!taken.removed) {
          throw new SandboxError(
            "provider-failed",
            `container ${id}: resource ${String(claimed.nativeId)} could not be removed; kept to retry`
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
          const recorded = JSON.stringify(parseContainerSpecInput(spec));
          await update({ row }, (current) => {
            assertNotClaimedElsewhere(current);
            const changed = recorded !== current.spec;
            const needsReplacement =
              changed &&
              (current.status === "running" || current.status === "paused");
            return {
              spec: recorded,
              ...(needsReplacement ? { status: "restarting" as const } : {}),
            };
          });
        }
        return;
      }
      const given =
        spec === undefined ? undefined : parseContainerSpecInput(spec);
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
        const input =
          given ?? parseContainerSpecInput(JSON.parse(entry.row.spec));
        await update(entry, {
          status: "restarting",
          ...(given === undefined ? {} : { spec: JSON.stringify(given) }),
        });
        try {
          await inventory.removeAttached(entry.row.id, entry, "restart");
          assertStillLive();
          await update(entry, (current) => ({
            nativeId: nextNativeName(current),
          }));
          assertStillLive();
          const booted = await boot(entry, input, signal);
          entry.vm = booted.vm;
          entry.nativeId = booted.nativeId;
          entry.labels = booted.labels;
          entry.spec = booted.spec;
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

    async resume(id, signal) {
      assertOpen();
      if (driver.connect === undefined) {
        throw new SandboxError(
          "unsupported",
          "driver does not support resuming paused containers"
        );
      }
      const running = live.get(id);
      if (running !== undefined) {
        throw new SandboxError(
          "invalid-transition",
          `container ${id} is running, not paused`
        );
      }
      let inflight = pending.get(id);
      if (inflight === undefined) {
        assertNotRemoving(id);
        inflight = bringingUp(id, async () => {
          await released(id);
          const existing = await rowOrThrow(id);
          if (existing.status !== "paused") {
            throw new SandboxError(
              "invalid-transition",
              `container ${id} is ${existing.status}, not paused`
            );
          }
          assertNotClaimedElsewhere(existing);
          const parsed = parseContainerSpecInput(JSON.parse(existing.spec));
          const reconnected = await tryReconnect(existing, parsed, signal);
          if (reconnected === undefined) {
            throw new SandboxError(
              "provider-failed",
              `paused container ${id} could not be reattached`
            );
          }
          return reconnected;
        });
      }
      return handleFor(await inflight);
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
      const input = parseContainerSpecInput(spec);
      const id = globalThis.crypto.randomUUID();
      const booted = await bringingUp(id, async () => {
        const row = await insert(id, input);
        return await bringUp({ row }, input, signal);
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
  if (current.status === "paused" && next.status === "running") {
    return "sandbox.resumed";
  }
  return ENTERED[next.status];
}

const ENTERED: Partial<Record<ContainerRow["status"], SandboxEvent["type"]>> = {
  failed: "sandbox.failed",
  paused: "sandbox.paused",
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

const ACTIVE_STATUSES: ReadonlySet<ContainerRow["status"]> = new Set([
  "paused",
  "restarting",
  "running",
  "starting",
]);

function nextNativeName(row: Pick<ContainerRow, "id" | "nativeId">): string {
  const prefix = `${row.id}-`;
  const previous =
    row.nativeId?.startsWith(prefix) === true
      ? Number.parseInt(row.nativeId.slice(prefix.length), 10)
      : 0;
  const generation = (Number.isNaN(previous) ? 0 : previous) + 1;
  return `${row.id}-${String(generation)}`;
}
