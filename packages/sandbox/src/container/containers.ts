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
  ACTIVE_CONTAINER_RESOURCE_STATUSES,
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  CONTAINER_STORE_LABEL,
  INVENTORY_PAGE_LIMIT,
  MAX_INVENTORY_PAGES,
  removeByHand,
} from "./defaults";
import {
  type AttachedContainer,
  attachContainer,
  resolveContainerMountSpecs,
} from "./facets";
import type {
  ContainerConfig,
  ContainerResourceSummary,
  ContainerRuntime,
} from "./runtime";
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

  const abandoned = new Map<string, string>();

  const abandon = (machine: Machine, rowId: string, own: string): void => {
    if (isRowsMachine(machine, rowId, own)) {
      abandoned.set(machine.name, rowId);
    } else {
      report(
        `container ${rowId}: the VM ${machine.name} would not go, and is not provably this instance's, so it is not kept to retry; remove it by hand with ${removeByHand(machine.name)}`
      );
    }
  };

  const report = (line: string): void => {
    try {
      (
        options.report ??
        ((text: string) => process.stderr.write(`foundry: ${text}\n`))
      )(line);
    } catch {
      // biome-ignore lint/complexity/noUselessReturn: End the best-effort operation on failure.
      return;
    }
  };

  const discard = async (
    machine: Machine,
    rowId: string,
    own: string,
    vm: AttachedContainer
  ): Promise<void> => {
    if (!isRowsMachine(machine, rowId, own)) {
      report(
        `container ${rowId}: the VM ${machine.name} it booted is not provably its own, so it is left; remove it by hand with ${removeByHand(machine.name)}`
      );
      return;
    }
    try {
      await vm.remove();
    } catch {
      abandon(machine, rowId, own);
    }
  };

  const removeNative = async (name: string, rowId: string): Promise<void> => {
    let resource: ContainerResourceSummary | undefined;
    let own: string;
    try {
      own = await store.identity();
      resource = (await enumerate(runtime, selection, undefined)).find(
        (each) => each.name === name
      );
    } catch (error: unknown) {
      if (ownsNativeName(rowId, name)) {
        abandoned.set(name, rowId);
      }
      report(
        `container ${rowId}: its old VM ${name} could not be judged (${String(error)}); kept to retry once the inventory can be read`
      );
      return;
    }
    if (resource === undefined) {
      return;
    }
    if (!isRowsMachine(resource, rowId, own)) {
      report(
        `container ${rowId}: its old VM ${name} is not provably this instance's, so it is left; remove it by hand with ${removeByHand(name)}`
      );
      return;
    }
    try {
      await dispose(runtime, resource);
    } catch {
      abandon(resource, rowId, own);
    }
  };

  const reclaim = async (
    signal: AbortSignal | undefined,
    own: string
  ): Promise<{
    readonly passedOver: string[];
    readonly removed: string[];
    readonly resources: readonly ContainerResourceSummary[];
  }> => {
    const candidates = [...abandoned];
    const recordedByAnother = recordedNames();
    const passedOver: string[] = [];
    const resources = await enumerate(runtime, selection, signal);
    const listed = new Map(
      resources.map((resource) => [resource.name, resource])
    );
    const removed: string[] = [];
    let failure: { readonly error: unknown } | undefined;
    for (const [name, rowId] of candidates) {
      if (abandoned.get(name) !== rowId) {
        continue;
      }
      const resource = listed.get(name);
      try {
        if (resource !== undefined) {
          if (
            isRowsMachine(resource, rowId, own) &&
            !(await recordedByAnother(name, rowId))
          ) {
            await dispose(runtime, resource);
            removed.push(name);
          } else {
            passedOver.push(name);
          }
        }
        abandoned.delete(name);
      } catch (error: unknown) {
        failure ??= { error };
      }
    }
    if (failure !== undefined) {
      throw new SandboxError(
        "provider-failed",
        `could not remove ${candidates
          .filter(([name]) => abandoned.has(name))
          .map(([name]) => name)
          .join(", ")}`,
        { cause: failure.error }
      );
    }
    return { passedOver, removed, resources };
  };

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

  const insert = (constraints: ContainerSandboxConstraints) => {
    const eventId = globalThis.crypto.randomUUID();
    return serialized(async (view): Promise<ContainerRow> => {
      const id = globalThis.crypto.randomUUID();
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
        await discard({ labels, name: nativeId }, row.id, own, vm);
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

  const removeOwned = async (
    entry: Live,
    action: "close" | "restart"
  ): Promise<void> => {
    const machine = { labels: entry.labels, name: entry.nativeId };
    const own = await store.identity();
    if (!isRowsMachine(machine, entry.row.id, own)) {
      report(
        `container ${entry.row.id}: its VM ${entry.nativeId} is not provably its own, so its ${action} left it; remove it by hand with ${removeByHand(entry.nativeId)}`
      );
      return;
    }
    try {
      await entry.vm.remove();
    } catch (error: unknown) {
      abandon(machine, entry.row.id, own);
      throw error;
    }
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
      await removeOwned(entry, "close");
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

  const clearMachines = async (row: ContainerRow): Promise<Clearance> => {
    const conflicts: string[] = [];
    const stuck: ContainerResourceSummary[] = [];
    let resources: readonly ContainerResourceSummary[];
    try {
      resources = await enumerate(runtime, selection, undefined);
    } catch {
      return { conflicts, stuck, unjudged: true };
    }
    const recordedByAnother = recordedNames();
    for (const resource of resources) {
      if (
        resource.labels[CONTAINER_ID_LABEL] !== row.id &&
        resource.name !== row.nativeId &&
        !ownsNativeName(row.id, resource.name)
      ) {
        continue;
      }
      const others = await anotherOwns(row, resource, recordedByAnother);
      if (others === undefined) {
        return { conflicts, stuck, unjudged: true };
      }
      if (others) {
        conflicts.push(resource.name);
      } else if (await disposeListed(resource)) {
        abandoned.delete(resource.name);
      } else {
        stuck.push(resource);
      }
    }
    return { conflicts, stuck, unjudged: false };
  };

  const removeClaimed = async (
    row: ContainerRow
  ): Promise<{
    readonly conflicts: readonly string[];
    readonly removed: boolean;
  }> => {
    const { conflicts, stuck, unjudged } = await clearMachines(row);
    const removed = !unjudged && conflicts.length === 0 && stuck.length === 0;
    if (removed) {
      await deleteHeld(row.id);
    }
    return { conflicts, removed };
  };

  const stopRow = async (id: string): Promise<void> => {
    const row = await rowOrThrow(id);
    assertNotClaimedElsewhere(row);
    const { conflicts, stuck, unjudged } = await clearMachines(row);
    if (unjudged) {
      if (row.nativeId !== undefined && ownsNativeName(id, row.nativeId)) {
        abandoned.set(row.nativeId, id);
      }
      throw new SandboxError(
        "provider-failed",
        `container ${id}: its VMs could not be judged; stop it again to retry`
      );
    }
    if (stuck.length > 0) {
      const own = await store.identity();
      for (const resource of stuck) {
        abandon(resource, id, own);
      }
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

  const anotherOwns = async (
    row: ContainerRow,
    machine: Machine,
    recordedByAnother: RecordedByAnother
  ): Promise<boolean | undefined> => {
    try {
      return (
        !isRowsMachine(machine, row.id, await store.identity()) ||
        (await recordedByAnother(machine.name, row.id))
      );
    } catch {
      return undefined;
    }
  };

  const recordedNames = (): RecordedByAnother => {
    let rows: Promise<readonly ContainerRow[]> | undefined;
    return async (name, except) => {
      rows ??= store.list();
      return (await rows).some(
        (stored) => stored.id !== except && stored.nativeId === name
      );
    };
  };

  const disposeListed = async (
    resource: ContainerResourceSummary
  ): Promise<boolean> => {
    try {
      await dispose(runtime, resource);
      return true;
    } catch {
      try {
        const listed = await enumerate(runtime, selection, undefined);
        return !listed.some((each) => each.name === resource.name);
      } catch {
        return false;
      }
    }
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
        inflight = (async () => {
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
            await removeNative(previous, id);
          }
          return bringUp({ row }, parseSpec(JSON.parse(row.spec)), signal);
        })().finally(() => pending.delete(id));
        pending.set(id, inflight);
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
        swept: swept.swept,
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
          await removeOwned(entry, "restart");
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
      if (abandoned.size > 0) {
        const { passedOver } = await reclaim(undefined, await store.identity());
        for (const name of passedOver) {
          report(
            `the VM ${name} this instance kept to retry is not provably its own now, so its shutdown left it; remove it by hand with ${removeByHand(name)}`
          );
        }
      }
      const failed = releases.find((result) => result.status === "rejected");
      if (failed !== undefined) {
        throw failed.reason;
      }
    },

    async start(spec, signal) {
      assertOpen();
      const constraints = parseSpec(spec);
      const row = await insert(constraints);
      return handleFor(await bringUp({ row }, constraints, signal));
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
      const own = await store.identity();
      const {
        passedOver,
        removed: swept,
        resources,
      } = await reclaim(signal, own);
      const recordedByAnother = recordedNames();
      for (const resource of resources) {
        assertNotAborted(signal, "container sweep was cancelled");
        if (
          swept.includes(resource.name) ||
          passedOver.includes(resource.name)
        ) {
          continue;
        }
        const id = resource.labels[CONTAINER_ID_LABEL];
        if (id === undefined || !isRowsMachine(resource, id, own)) {
          passedOver.push(resource.name);
          continue;
        }
        if (
          (await store.get(id)) !== undefined ||
          (await recordedByAnother(resource.name))
        ) {
          continue;
        }
        await dispose(runtime, resource);
        swept.push(resource.name);
      }
      return Object.freeze({
        passedOver: Object.freeze(passedOver),
        swept: Object.freeze(swept),
      });
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

interface Clearance {
  readonly conflicts: readonly string[];
  readonly stuck: readonly ContainerResourceSummary[];
  readonly unjudged: boolean;
}

interface Machine {
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
}

function isRowsMachine(
  machine: Machine,
  rowId: string,
  store: string
): boolean {
  return (
    machine.labels[CONTAINER_STORE_LABEL] === store &&
    ownsNativeName(rowId, machine.name) &&
    machine.labels[CONTAINER_ID_LABEL] === rowId
  );
}

function ownsNativeName(rowId: string, name: string): boolean {
  return (
    name.startsWith(`${rowId}-`) &&
    GENERATION.test(name.slice(rowId.length + 1))
  );
}

const GENERATION = /^\d+$/;

type RecordedByAnother = (name: string, except?: string) => Promise<boolean>;

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

async function dispose(
  runtime: ContainerRuntime,
  resource: ContainerResourceSummary
): Promise<void> {
  if (ACTIVE_CONTAINER_RESOURCE_STATUSES.has(resource.status)) {
    await runtime.stopResource(resource.name);
  }
  await runtime.removeResource(resource.name);
}

async function enumerate(
  runtime: ContainerRuntime,
  labels: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined
): Promise<readonly ContainerResourceSummary[]> {
  const resources: ContainerResourceSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
    assertNotAborted(signal, "container sweep was cancelled");
    const result = await runtime.listResources({
      labels,
      limit: INVENTORY_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    resources.push(...result.resources);
    if (result.nextCursor === undefined) {
      return resources;
    }
    cursor = result.nextCursor;
  }
  throw new SandboxError(
    "provider-failed",
    "container inventory did not terminate"
  );
}
