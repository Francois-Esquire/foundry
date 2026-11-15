import { SandboxError } from "../errors";
import { assertNotAborted } from "../sandbox";
import type { ContainerRow, SandboxEvent } from "../schema";
import type { ContainerStore } from "../store/index";
import { createMemoryContainerStore } from "../store/memory";
import {
  ACTIVE_CONTAINER_RESOURCE_STATUSES,
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  INVENTORY_PAGE_LIMIT,
  MAX_INVENTORY_PAGES,
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
  /** Canonical host directories a spec may bind mounts from. */
  readonly allowedMountRoots?: readonly string[];
  /**
   * Defaults every spec resolves over: a field the spec sets wins, `env` and
   * labels merge key by key, and the rest — pull policy, network, resources —
   * falls back to these. The registry always assigns the native name.
   */
  readonly config?: ContainerConfig;
  /**
   * This registry's token as a row's holder: written on every row it
   * writes, so a row is taken over only while the holder it was judged by
   * is still the one stored. Opaque here; a host that can tell when a
   * holder is gone gives one it can read back (`recover`). A fresh random
   * token when omitted.
   */
  readonly holder?: string;
  /** Host-derived label separating this data directory's VMs from any other. */
  readonly instanceLabel: string;
  /** Guest directory every mount target must equal or fall under. */
  readonly mountTargetRoot?: string;
  readonly runtime: ContainerRuntime;
  /** Persistence. Defaults to an in-memory store. */
  readonly store?: ContainerStore;
}

export interface Containers {
  list(): Promise<readonly ContainerRow[]>;
  /** Join a row: another handle if its VM runs here, else a restart under the same row. */
  open(id: string, signal?: AbortSignal): Promise<Container>;
  /**
   * Take back what processes that are gone left, after a crash: each row
   * not live here that `left` says a gone process left is claimed for
   * removal, in one store transaction and only while its holder and last
   * write are still the ones `left` was shown, so a registry that opened
   * it meanwhile keeps it. A claimed row is marked `removing` under this
   * registry, its VM removed, and the row deleted only once the runtime
   * no longer lists the VM; one whose VM would not go stays `removing`,
   * listed in `kept`, for a later recovery to take over and retry. Then
   * every VM with this instance's labels and no row is swept. A row live
   * here, or being opened or removed here, is never offered.
   */
  recover(
    left: (row: ContainerRow) => boolean | Promise<boolean>,
    signal?: AbortSignal
  ): Promise<ContainerRecovery>;
  /**
   * Delete a row whose VM is not live here, removing whatever the runtime
   * still holds under its native name. The row is marked `removing` first,
   * and deleted only once the runtime no longer lists the VM; one that
   * would not go rejects, its row kept `removing` so a later recovery
   * retries it. Refuses while a handle is open; an `open` or `restart`
   * that begins before the delete commits is refused.
   */
  remove(id: string): Promise<void>;
  /**
   * The one change mechanism. Replaces the VM under the same row, with a new
   * spec when given. Open handles stay valid and see the new sandbox.
   * Restarts of one container take turns; one whose last handle closes before
   * it finishes stops and rejects, and the close removes whatever it booted.
   */
  restart(
    id: string,
    spec?: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<void>;
  /**
   * Close every handle and stop every VM; rows go to `stopped`. Then retry
   * every VM this registry could not remove, and reject while any remains;
   * calling it again retries them.
   */
  shutdown(): Promise<void>;
  /** New row, new VM, one handle. */
  start(
    spec: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<Container>;
  /**
   * Stop and remove every VM carrying this instance's labels but no row, and
   * every VM this registry booted or set out to remove but could not remove.
   * Returns the native names swept.
   */
  sweep(signal?: AbortSignal): Promise<readonly string[]>;
}

/**
 * What `recover` took back: the rows it removed, the rows it claimed but
 * whose VM would not go (kept, `removing`, to retry), and the native names
 * it swept.
 */
export interface ContainerRecovery {
  readonly kept: readonly string[];
  readonly removed: readonly string[];
  readonly swept: readonly string[];
}

/**
 * One handle on a running container. Every facet reads through to the current
 * VM, so it changes under the handle after `restart`; don't hold a facet
 * across one.
 */
export interface Container extends ContainerFacets {
  /** Drop this handle. The last handle out stops and removes the VM. Idempotent. */
  close(): Promise<void>;
  readonly id: string;
  /** The row as last written by this registry. */
  readonly row: ContainerRow;
}

/** The fields a registry write may change. Identity and creation time are fixed. */
type RowPatch = Partial<Pick<ContainerRow, "nativeId" | "spec" | "status">>;

interface Live {
  facets: ContainerFacets;
  handles: number;
  /** The native name `sandbox` was booted under. */
  nativeId: string;
  row: ContainerRow;
  sandbox: ContainerSandbox;
  /** The restart in progress, settled; a release waits for it. */
  turn: Promise<void>;
}

/**
 * One row per container, one VM per row at a time. A VM that outlives this
 * process is not adopted: `open` on a row not live here restarts it under a
 * new native name, after removing whatever the runtime still holds under the
 * old one.
 */
export function createContainers(options: CreateContainersOptions): Containers {
  const { runtime } = options;
  const store = options.store ?? createMemoryContainerStore();
  const holder = options.holder ?? globalThis.crypto.randomUUID();
  const live = new Map<string, Live>();
  const pending = new Map<string, Promise<Live>>();
  const releasing = new Map<string, Promise<void>>();
  /** Ids reserved by a `remove` from its checks until its delete commits. */
  const removing = new Set<string>();
  let stopped = false;
  let tail: Promise<unknown> = Promise.resolve();

  const selection = Object.freeze({
    [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
    [CONTAINER_INSTANCE_LABEL]: options.instanceLabel,
  });

  /**
   * Native names of VMs no live row holds that this registry booted or set
   * out to remove, and could not remove. They stay this registry's to
   * remove: `sweep` and `shutdown` retry them. A native name is never booted
   * twice, so a name here never becomes live again.
   */
  const abandoned = new Set<string>();

  /** Remove a VM no live row holds; one that will not go is kept to retry. */
  const discard = async (
    name: string,
    sandbox: ContainerSandbox
  ): Promise<void> => {
    try {
      await sandbox.remove();
    } catch {
      abandoned.add(name);
    }
  };

  /**
   * Remove an old VM by its native name. A stop or remove that fails may mean
   * the VM is gone (the expected case) or that it is stuck, and the runtime
   * cannot say which, so the name is kept for `sweep` and `shutdown`: their
   * inventory drops it if it is gone and retries it if it is not.
   */
  const removeNative = async (name: string): Promise<void> => {
    try {
      await runtime.stopResource(name);
      await runtime.removeResource(name);
    } catch {
      abandoned.add(name);
    }
  };

  /**
   * Read the runtime's inventory, then retry the VMs that were abandoned
   * before it was read: remove those it lists, forget those it does not. A
   * name abandoned while the inventory was being read is left for the next
   * call, as the inventory may predate its VM. Returns the inventory and the
   * names removed; rejects, keeping the rest, if any would not go.
   */
  const reclaim = async (
    signal: AbortSignal | undefined
  ): Promise<{
    readonly removed: string[];
    readonly resources: readonly ContainerResourceSummary[];
  }> => {
    const candidates = [...abandoned];
    const resources = await enumerate(runtime, selection, signal);
    const listed = new Map(
      resources.map((resource) => [resource.name, resource])
    );
    const removed: string[] = [];
    let failure: { readonly error: unknown } | undefined;
    for (const name of candidates) {
      if (!abandoned.has(name)) {
        continue;
      }
      const resource = listed.get(name);
      try {
        if (resource !== undefined) {
          await dispose(runtime, resource);
          removed.push(name);
        }
        abandoned.delete(name);
      } catch (error: unknown) {
        failure ??= { error };
      }
    }
    if (failure !== undefined) {
      throw new SandboxError(
        "provider-failed",
        `could not remove ${candidates.filter((name) => abandoned.has(name)).join(", ")}`,
        { cause: failure.error }
      );
    }
    return { removed, resources };
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

  /**
   * Runs one read-modify-write of the store: serialized in this registry, and
   * inside the store's transaction when it offers one, so no other write from
   * any registry over the store lands between its reads and its commit.
   * `work` reads and commits through `view` only. Runtime calls stay outside,
   * so a slow VM holds up no other row.
   */
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

  /**
   * Changes fields of a row that must still exist, over the row as stored,
   * and keeps the result on the entry. Identity and creation time are fixed.
   * A patch that depends on the row is worked out from the row as stored.
   */
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

  /** A new row in `starting` under its first native name, refused if the id is taken. */
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

  /**
   * Boot a VM under the native name the row already records, then record
   * whether it came up. The name is written first so that a VM this process
   * never got to remove can still be found and removed by the next boot.
   */
  const boot = async (
    entry: { row: ContainerRow },
    constraints: ContainerSandboxConstraints,
    signal: AbortSignal | undefined
  ): Promise<Pick<Live, "facets" | "nativeId" | "sandbox">> => {
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
    const config: ContainerConfig = {
      ...resolved,
      labels: {
        ...resolved.labels,
        ...selection,
        [CONTAINER_ID_LABEL]: row.id,
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
        // The VM exists and would not go: keep it for `sweep` and `shutdown`.
        { onLeftBehind: () => abandoned.add(nativeId) }
      );
    } catch (error: unknown) {
      // The boot's own error is the one to report; the row is best effort.
      await update(entry, { status: "failed" }).catch(() => undefined);
      throw error;
    }
    try {
      await update(entry, { status: "running" });
    } catch (error: unknown) {
      // The VM is up but its row could not say so, and no live row will
      // hold it: remove it now, or keep it for `sweep` and `shutdown`.
      await discard(nativeId, sandbox);
      await update(entry, { status: "failed" }).catch(() => undefined);
      throw error;
    }
    return {
      facets: containerFacets(
        sandbox,
        mounts,
        (options.allowedMountRoots?.length ?? 0) > 0
      ),
      nativeId,
      sandbox,
    };
  };

  /** Boot a row whose native name is already recorded, and make it live. */
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
      // A restart under way finishes first, so the VM removed is its VM.
      await entry.turn;
      try {
        await entry.sandbox.remove();
      } catch (error: unknown) {
        // No live row holds it any more: keep it for `sweep` and `shutdown`.
        abandoned.add(entry.nativeId);
        throw error;
      }
      await update(entry, { status: "stopped" });
    })().finally(() => releasing.delete(entry.row.id));
    releasing.set(entry.row.id, done);
    return done;
  };

  /** A failed release is the next boot's problem: `open` removes the old VM. */
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

  /**
   * Remove the VM `name`: whether the runtime no longer lists it. A stop
   * or remove that fails may mean it is gone already; the inventory says.
   * One still listed is retried through its row, which stays `removing`.
   */
  const removeVm = async (name: string): Promise<boolean> => {
    try {
      await runtime.stopResource(name);
      await runtime.removeResource(name);
      return true;
    } catch {
      try {
        const resources = await enumerate(runtime, selection, undefined);
        if (!resources.some((resource) => resource.name === name)) {
          return true;
        }
      } catch {
        // An inventory that cannot be read proves nothing gone.
      }
      return false;
    }
  };

  /**
   * Mark the row `removing` under this registry, in one store transaction;
   * when `judged` is given, only while the row's holder and last write are
   * still those, so a row another registry took meanwhile is left to it.
   * The row as claimed; `undefined` when it was not.
   */
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

  /**
   * Delete the row `id` while this registry still holds it, recording it
   * destroyed. Another registry that took the row meanwhile, or deleted it,
   * keeps it: then nothing is deleted, and nothing destroyed here.
   */
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

  /** A claimed row's VM removed and the row deleted; whether both went. */
  const removeClaimed = async (row: ContainerRow): Promise<boolean> => {
    if (row.nativeId !== undefined && !(await removeVm(row.nativeId))) {
      return false;
    }
    await deleteHeld(row.id);
    return true;
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
          // Claimed before anything else: from here this registry holds the
          // row, and a recovery that judged it by its last holder leaves it.
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
            await removeNative(previous);
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
      for (const row of await store.list()) {
        assertNotAborted(signal, "container recovery was cancelled");
        const { id } = row;
        // Judged outside any transaction; the claim checks it still holds.
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
            ((await removeClaimed(claimed)) ? removed : kept).push(id);
          }
        } finally {
          removing.delete(id);
        }
      }
      const swept = await containers.sweep(signal);
      return Object.freeze({
        kept: Object.freeze(kept),
        removed: Object.freeze(removed),
        swept,
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
      // Reserved before the first await and held until the delete commits,
      // so no `open` can begin on the row while it is being removed.
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
        if (!(await removeClaimed(claimed))) {
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
        // Not live here: the next `open` boots it with the new spec.
        assertNotRemoving(id);
        const row = await rowOrThrow(id);
        if (spec !== undefined) {
          await update({ row }, { spec: JSON.stringify(parseSpec(spec)) });
        }
        return;
      }
      const given = spec === undefined ? undefined : parseSpec(spec);
      /** Refuses to go on once the last handle has closed. */
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
        // Read at its turn, so a restart queued behind one with a new spec
        // boots that spec rather than the one stored when it was called.
        const constraints = given ?? parseSpec(JSON.parse(entry.row.spec));
        await update(entry, {
          status: "restarting",
          ...(given === undefined ? {} : { spec: JSON.stringify(given) }),
        });
        await entry.sandbox.remove();
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
          // A close during the boot is waiting to remove the VM just booted.
          assertStillLive();
        } catch (error: unknown) {
          if (live.get(id) === entry) {
            live.delete(id);
          }
          throw error;
        }
      };
      // Restarts of one container take turns; a release waits for the last.
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
        await reclaim(undefined);
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
      const { removed: swept, resources } = await reclaim(signal);
      for (const resource of resources) {
        assertNotAborted(signal, "container sweep was cancelled");
        if (swept.includes(resource.name)) {
          continue;
        }
        const id = resource.labels[CONTAINER_ID_LABEL];
        if (id !== undefined && (await store.get(id)) !== undefined) {
          continue;
        }
        await dispose(runtime, resource);
        swept.push(resource.name);
      }
      return Object.freeze(swept);
    },
  };
  return Object.freeze(containers);
}

/**
 * The event an update from the row as stored (`current`) to `next` records:
 * entering `running`, `stopped` or `failed` from any other status, whatever
 * came before (a boot after a failure, a restart). Moves to `starting` or
 * `restarting`, a row already in its status, and changes to the native name
 * or the spec alone record nothing.
 */
function enteredEvent(
  current: ContainerRow,
  next: ContainerRow
): SandboxEvent["type"] | undefined {
  if (next.status === current.status) {
    return;
  }
  return ENTERED[next.status];
}

/** The event each status records when a row enters it; others record none. */
const ENTERED: Partial<Record<ContainerRow["status"], SandboxEvent["type"]>> = {
  failed: "sandbox.failed",
  running: "sandbox.started",
  stopped: "sandbox.stopped",
};

/** The event of `type` on container `containerId`, at epoch milliseconds `at`. */
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

/** `<rowId>-<generation>`, the generation read back off the previous native id. */
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
