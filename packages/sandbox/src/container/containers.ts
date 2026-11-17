import { SandboxError } from "../errors";
import { assertNotAborted } from "../sandbox";
import type { ContainerRow } from "../schema";
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
  /** Host-derived label separating this data directory's VMs from any other. */
  readonly instanceLabel: string;
  /** Guest directory every mount target must equal or fall under. */
  readonly mountTargetRoot?: string;
  readonly runtime: ContainerRuntime;
  readonly store?: ContainerStore;
}

export interface Containers {
  list(): Promise<readonly ContainerRow[]>;
  /** Join a row: another handle if its VM runs here, else a restart under the same row. */
  open(id: string, signal?: AbortSignal): Promise<Container>;
  remove(id: string): Promise<void>;
  restart(
    id: string,
    spec?: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<void>;
  shutdown(): Promise<void>;
  /** New row, new VM, one handle. */
  start(
    spec: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<Container>;
  sweep(signal?: AbortSignal): Promise<readonly string[]>;
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

type RowPatch = Partial<Pick<ContainerRow, "nativeId" | "spec" | "status">>;

interface Live {
  facets: ContainerFacets;
  handles: number;
  nativeId: string;
  row: ContainerRow;
  sandbox: ContainerSandbox;
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

  const abandoned = new Set<string>();

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

  const removeNative = async (name: string): Promise<void> => {
    try {
      await runtime.stopResource(name);
      await runtime.removeResource(name);
    } catch {
      abandoned.add(name);
    }
  };

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
    entry.row = await serialized(async (view) => {
      const current = await rowOrThrow(entry.row.id, view);
      const next: ContainerRow = Object.freeze({
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
        updatedAt: Date.now(),
      });
      await view.commit({ putContainers: [next] });
      return next;
    });
  };

  const insert = (constraints: ContainerSandboxConstraints) =>
    serialized(async (view): Promise<ContainerRow> => {
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
        id,
        nativeId: nextNativeId({ id, nativeId: undefined }),
        spec: JSON.stringify(constraints),
        status: "starting",
        updatedAt: now,
      });
      await view.commit({ putContainers: [row] });
      return row;
    });

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
        { onLeftBehind: () => abandoned.add(nativeId) }
      );
    } catch (error: unknown) {
      await update(entry, { status: "failed" }).catch(() => undefined);
      throw error;
    }
    try {
      await update(entry, { status: "running" });
    } catch (error: unknown) {
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
      try {
        await entry.sandbox.remove();
      } catch (error: unknown) {
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
          const row = await rowOrThrow(id);
          if (row.nativeId !== undefined) {
            await removeNative(row.nativeId);
          }
          const entry = { row };
          await update(entry, (current) => ({
            nativeId: nextNativeId(current),
            status: "starting",
          }));
          return bringUp(entry, parseSpec(JSON.parse(row.spec)), signal);
        })().finally(() => pending.delete(id));
        pending.set(id, inflight);
      }
      return handleFor(await inflight);
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
        const row = await rowOrThrow(id);
        if (row.nativeId !== undefined) {
          await removeNative(row.nativeId);
        }
        await serialized((view) => view.commit({ deleteContainers: [id] }));
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
