import { SandboxError } from "../errors";
import { assertNotAborted } from "../sandbox";
import type { ContainerRow, SandboxEvent } from "../schema";
import type { ContainerStore, ContainerStoreWrite } from "../store/index";
import { MemoryContainerStore } from "../store/memory";
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
} from "./constants";
import type { ContainerSandboxConstraints } from "./constraints";
import {
  containerSandboxConfigFromConstraints,
  containerSandboxConstraintsSchema,
} from "./constraints";
import type { ContainerFacets } from "./facets";
import { containerFacets, resolveContainerMountSpecs } from "./facets";
import { provisionContainerSandbox, startContainerSandbox } from "./sandbox";
import type {
  ContainerConfig,
  ContainerMountSpec,
  ContainerResourceSummary,
  ContainerRuntime,
  ContainerSandbox,
} from "./types";

export interface CreateContainersOptions {
  readonly allowedMountRoots?: readonly string[];
  readonly config?: ContainerConfig;
  readonly holder?: string;
  readonly instanceLabel: string;
  readonly mountTargetRoot?: string;
  readonly report?: (line: string) => void;
  readonly runtime: ContainerRuntime;
  readonly store?: ContainerStore;
}

export interface Containers {
  list(): Promise<readonly ContainerRow[]>;
  open(id: string, signal?: AbortSignal): Promise<Container>;
  recover(
    left: (row: ContainerRow) => boolean | Promise<boolean>,
    signal?: AbortSignal
  ): Promise<ContainerRecovery>;
  remove(id: string): Promise<void>;
  restart(
    id: string,
    spec?: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<void>;
  shutdown(): Promise<void>;
  start(
    spec: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<Container>;
  sweep(signal?: AbortSignal): Promise<ContainerSweep>;
}

export type ContainerSweep = readonly string[] & {
  readonly passedOver: readonly string[];
};

export interface ContainerRecovery {
  readonly conflicts: readonly string[];
  readonly kept: readonly string[];
  readonly passedOver: readonly string[];
  readonly removed: readonly string[];
  readonly swept: readonly string[];
}

export interface Container extends ContainerFacets {
  close(): Promise<void>;
  readonly id: string;
  readonly row: ContainerRow;
}

type RowPatch = Partial<Pick<ContainerRow, "nativeId" | "spec" | "status">>;

interface Live {
  facets: ContainerFacets;
  handles: number;
  labels: Readonly<Record<string, string>>;
  nativeId: string;
  row: ContainerRow;
  sandbox: ContainerSandbox;
  turn: Promise<void>;
}

export function createContainers(options: CreateContainersOptions): Containers {
  const { runtime } = options;
  const store = ownNamesOnly(options.store ?? new MemoryContainerStore());
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
        `container ${rowId}: the VM ${machine.name} would not go, and is not provably this registry's, so it is not kept to retry; remove it by hand with ${removeByHand(machine.name)}`
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
    sandbox: ContainerSandbox
  ): Promise<void> => {
    if (!isRowsMachine(machine, rowId, own)) {
      report(
        `container ${rowId}: the VM ${machine.name} it booted is not provably its own, so it is left; remove it by hand with ${removeByHand(machine.name)}`
      );
      return;
    }
    try {
      await sandbox.remove();
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
        `container ${rowId}: its old VM ${name} is not provably this registry's, so it is left; remove it by hand with ${removeByHand(name)}`
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
      await view.commit({
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
  ): Promise<Pick<Live, "facets" | "labels" | "nativeId" | "sandbox">> => {
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
    const config: ContainerConfig = {
      ...resolved,
      labels: {
        ...resolved.labels,
        ...selection,
        [CONTAINER_ID_LABEL]: row.id,
        [CONTAINER_STORE_LABEL]: own,
      },
      name: nativeId,
    };
    let sandbox: ContainerSandbox;
    let mounts: readonly ContainerMountSpec[];
    try {
      mounts = await resolveContainerMountSpecs(
        constraints.mounts ?? [],
        options.allowedMountRoots ?? [],
        options.mountTargetRoot
      );
      sandbox = await startContainerSandbox(
        await provisionContainerSandbox(config, { runtime }, mounts),
        {
          mayRemove: () =>
            isRowsMachine(
              { labels: config.labels ?? {}, name: nativeId },
              row.id,
              own
            ),
          onLeftBehind: () =>
            abandon(
              { labels: config.labels ?? {}, name: nativeId },
              row.id,
              own
            ),
        }
      );
    } catch (error: unknown) {
      await update(entry, { status: "failed" }).catch(() => undefined);
      throw error;
    }
    try {
      await update(entry, { status: "running" });
    } catch (error: unknown) {
      await discard(
        { labels: config.labels ?? {}, name: nativeId },
        row.id,
        own,
        sandbox
      );
      await update(entry, { status: "failed" }).catch(() => undefined);
      throw error;
    }
    return {
      facets: containerFacets(
        sandbox,
        mounts,
        (options.allowedMountRoots?.length ?? 0) > 0
      ),
      labels: config.labels ?? {},
      nativeId,
      sandbox,
    };
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

  const release = (entry: Live): Promise<void> => {
    live.delete(entry.row.id);
    const done = (async () => {
      await entry.turn;
      const machine = { labels: entry.labels, name: entry.nativeId };
      const own = await store.identity();
      if (isRowsMachine(machine, entry.row.id, own)) {
        try {
          await entry.sandbox.remove();
        } catch (error: unknown) {
          abandon(machine, entry.row.id, own);
          throw error;
        }
      } else {
        report(
          `container ${entry.row.id}: its VM ${entry.nativeId} is not provably its own, so its close left it; remove it by hand with ${removeByHand(entry.nativeId)}`
        );
      }
      await update(entry, { status: "stopped" });
    })().finally(() => releasing.delete(entry.row.id));
    releasing.set(entry.row.id, done);
    return done;
  };

  const released = (id: string): Promise<void> | undefined =>
    releasing.get(id)?.catch(() => undefined);

  const handleFor = (entry: Live): Container => {
    entry.handles += 1;
    let closed = false;
    return Object.freeze({
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        entry.handles -= 1;
        if (entry.handles === 0 && live.get(entry.row.id) === entry) {
          await release(entry);
        }
      },
      get commands() {
        return entry.facets.commands;
      },
      get files() {
        return entry.facets.files;
      },
      id: entry.row.id,
      get ports() {
        return entry.facets.ports;
      },
      get processes() {
        return entry.facets.processes;
      },
      get row() {
        return entry.row;
      },
      get services() {
        return entry.facets.services;
      },
      get shell() {
        return entry.facets.shell;
      },
      get volumes() {
        return entry.facets.volumes;
      },
      get workingDirectory() {
        return entry.facets.workingDirectory;
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

  const assertOpen = (): void => {
    if (stopped) {
      throw new SandboxError(
        "invalid-transition",
        "containers registry has shut down"
      );
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
    let resources: readonly ContainerResourceSummary[];
    try {
      resources = await enumerate(runtime, selection, undefined);
    } catch {
      return { conflicts: [], removed: false };
    }
    const conflicts: string[] = [];
    let removed = true;
    for (const resource of resources) {
      if (
        resource.labels[CONTAINER_ID_LABEL] !== row.id &&
        resource.name !== row.nativeId &&
        !ownsNativeName(row.id, resource.name)
      ) {
        continue;
      }
      const others = await anotherOwns(row, resource);
      if (others === undefined) {
        return { conflicts, removed: false };
      }
      if (others) {
        conflicts.push(resource.name);
      } else if (!(await disposeListed(resource))) {
        removed = false;
      }
    }
    if (conflicts.length > 0 || !removed) {
      return { conflicts, removed: false };
    }
    await deleteHeld(row.id);
    return { conflicts, removed: true };
  };

  const anotherOwns = async (
    row: ContainerRow,
    machine: Machine
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

  const recordedByAnother = async (
    name: string,
    except?: string
  ): Promise<boolean> =>
    (await store.list()).some(
      (stored) => stored.id !== except && stored.nativeId === name
    );

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
            if (current.status === "removing" && current.holder !== holder) {
              throw new SandboxError(
                "invalid-transition",
                `container ${id} is being removed`
              );
            }
            previous = current.nativeId;
            const claimed: ContainerRow = Object.freeze({
              ...current,
              holder,
              nativeId: nextNativeId(current),
              status: "starting",
              updatedAt: Date.now(),
            });
            await view.commit({ putContainers: [claimed] });
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
        if (spec !== undefined) {
          await update({ row }, { spec: JSON.stringify(parseSpec(spec)) });
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
        if (
          isRowsMachine(
            { labels: entry.labels, name: entry.nativeId },
            id,
            await store.identity()
          )
        ) {
          await entry.sandbox.remove();
        } else {
          report(
            `container ${id}: its VM ${entry.nativeId} is not provably its own, so its restart left it; remove it by hand with ${removeByHand(entry.nativeId)}`
          );
        }
        assertStillLive();
        try {
          await update(entry, (current) => ({
            nativeId: nextNativeId(current),
          }));
          assertStillLive();
          const booted = await boot(entry, constraints, signal);
          entry.sandbox = booted.sandbox;
          entry.facets = booted.facets;
          entry.nativeId = booted.nativeId;
          entry.labels = booted.labels;
          assertStillLive();
        } catch (error: unknown) {
          if (live.get(id) === entry) {
            live.delete(id);
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
            `the VM ${name} this registry kept to retry is not provably its own now, so its shutdown left it; remove it by hand with ${removeByHand(name)}`
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
    async sweep(signal) {
      assertOpen();
      const own = await store.identity();
      const {
        passedOver,
        removed: swept,
        resources,
      } = await reclaim(signal, own);
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
      return sweepResult(swept, passedOver);
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

function sweepResult(
  swept: readonly string[],
  passedOver: readonly string[]
): ContainerSweep {
  const result = [...swept];
  Object.defineProperty(result, "passedOver", {
    enumerable: false,
    value: Object.freeze([...passedOver]),
  });
  return Object.freeze(result) as unknown as ContainerSweep;
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

function ownNamesOnly(store: ContainerStore): ContainerStore {
  const checked = (write: ContainerStoreWrite): SandboxError | undefined => {
    const row = (write.putContainers ?? []).find(
      (each) =>
        each.nativeId !== undefined && !ownsNativeName(each.id, each.nativeId)
    );
    return row === undefined
      ? undefined
      : new SandboxError(
          "invalid-contract",
          `container ${row.id} records the native name ${String(row.nativeId)}, which is not one of its own`
        );
  };
  const guard = (view: ContainerStore): ContainerStore =>
    new Proxy(view, {
      get(target, property, receiver) {
        if (property === "commit") {
          return (write: ContainerStoreWrite) => {
            const refused = checked(write);
            return refused === undefined
              ? target.commit(write)
              : Promise.reject(refused);
          };
        }
        if (property === "transaction" && target.transaction !== undefined) {
          const { transaction } = target;
          return <T>(work: (inner: ContainerStore) => Promise<T>) =>
            transaction.call(target, (inner) => work(guard(inner)));
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return guard(store);
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
