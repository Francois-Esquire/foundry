import { SandboxError } from "../errors";
import { assertNotAborted } from "../sandbox";
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
import type { ContainerRow, ContainerStore } from "./store";
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
  readonly store: ContainerStore;
}

export interface Containers {
  list(): Promise<readonly ContainerRow[]>;
  /** Join a row: another handle if its VM runs here, else a restart under the same row. */
  open(id: string, signal?: AbortSignal): Promise<Container>;
  /**
   * Delete a row whose VM is not live here, removing whatever the runtime
   * still holds under its native name. Refuses while a handle is open.
   */
  remove(id: string): Promise<void>;
  /**
   * The one change mechanism. Replaces the VM under the same row, with a new
   * spec when given. Open handles stay valid and see the new sandbox.
   */
  restart(
    id: string,
    spec?: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<void>;
  /** Close every handle and stop every VM; rows go to `stopped`. */
  shutdown(): Promise<void>;
  /** New row, new VM, one handle. */
  start(
    spec: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<Container>;
  /** Stop and remove every VM carrying this instance's labels but no row. Returns the native names swept. */
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

interface Live {
  facets: ContainerFacets;
  handles: number;
  row: ContainerRow;
  sandbox: ContainerSandbox;
}

/**
 * One row per container, one VM per row at a time. A VM that outlives this
 * process is not adopted: `open` on a row not live here restarts it under a
 * new native name, after removing whatever the runtime still holds under the
 * old one.
 */
export function createContainers(options: CreateContainersOptions): Containers {
  const { runtime, store } = options;
  const live = new Map<string, Live>();
  const pending = new Map<string, Promise<Live>>();
  const releasing = new Map<string, Promise<void>>();
  let stopped = false;

  const selection = Object.freeze({
    [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
    [CONTAINER_INSTANCE_LABEL]: options.instanceLabel,
  });

  const update = async (
    entry: { row: ContainerRow },
    patch: Partial<Pick<ContainerRow, "nativeId" | "spec" | "status">>
  ): Promise<void> => {
    const next = { ...patch, updatedAt: Date.now() };
    await store.update(entry.row.id, next);
    entry.row = Object.freeze({ ...entry.row, ...next });
  };

  /** Boot a VM for the row and bind it into `entry`. Status is the caller's. */
  const boot = async (
    entry: { row: ContainerRow },
    constraints: ContainerSandboxConstraints,
    signal: AbortSignal | undefined
  ): Promise<Pick<Live, "sandbox" | "facets">> => {
    assertNotAborted(signal, "container start was cancelled");
    const { row } = entry;
    const nativeId = nextNativeId(row);
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
    await update(entry, { nativeId });
    let sandbox: ContainerSandbox;
    let mounts: readonly ContainerMountSpec[];
    try {
      mounts = await resolveContainerMountSpecs(
        constraints.mounts ?? [],
        options.allowedMountRoots ?? [],
        options.mountTargetRoot
      );
      sandbox = await startContainerSandbox(
        await provisionContainerSandbox(config, { runtime }, mounts)
      );
    } catch (error: unknown) {
      await update(entry, { status: "failed" });
      throw error;
    }
    await update(entry, { status: "running" });
    return {
      facets: containerFacets(
        sandbox,
        mounts,
        (options.allowedMountRoots?.length ?? 0) > 0
      ),
      sandbox,
    };
  };

  const bringUp = async (
    row: ContainerRow,
    constraints: ContainerSandboxConstraints,
    signal: AbortSignal | undefined
  ): Promise<Live> => {
    const entry = { row };
    await update(entry, { status: "starting" });
    const booted = await boot(entry, constraints, signal);
    const created: Live = { ...booted, handles: 0, row: entry.row };
    live.set(row.id, created);
    return created;
  };

  const release = (entry: Live): Promise<void> => {
    live.delete(entry.row.id);
    const done = (async () => {
      await entry.sandbox.remove();
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

  const assertOpen = (): void => {
    if (stopped) {
      throw new SandboxError(
        "invalid-transition",
        "containers registry has shut down"
      );
    }
  };

  const rowOrThrow = async (id: string): Promise<ContainerRow> => {
    const row = await store.get(id);
    if (row === undefined) {
      throw new SandboxError(
        "invalid-contract",
        `container ${id} does not exist`
      );
    }
    return row;
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
        inflight = (async () => {
          await released(id);
          const row = await rowOrThrow(id);
          if (row.nativeId !== undefined) {
            await removeNative(runtime, row.nativeId);
          }
          return bringUp(row, parseSpec(JSON.parse(row.spec)), signal);
        })().finally(() => pending.delete(id));
        pending.set(id, inflight);
      }
      return handleFor(await inflight);
    },

    async remove(id) {
      assertOpen();
      await released(id);
      if (live.has(id) || pending.has(id)) {
        throw new SandboxError(
          "invalid-transition",
          `container ${id} is live; close every handle before removing it`
        );
      }
      const row = await rowOrThrow(id);
      if (row.nativeId !== undefined) {
        await removeNative(runtime, row.nativeId);
      }
      await store.remove(id);
    },

    async restart(id, spec, signal) {
      assertOpen();
      const entry = live.get(id);
      if (entry === undefined) {
        // Not live here: the next `open` boots it with the new spec.
        const row = await rowOrThrow(id);
        if (spec !== undefined) {
          await update(
            { row },
            { spec: JSON.stringify(parseSpec(spec)), status: row.status }
          );
        }
        return;
      }
      const constraints =
        spec === undefined
          ? parseSpec(JSON.parse(entry.row.spec))
          : parseSpec(spec);
      await update(entry, {
        status: "restarting",
        ...(spec === undefined ? {} : { spec: JSON.stringify(constraints) }),
      });
      await entry.sandbox.remove();
      try {
        const booted = await boot(entry, constraints, signal);
        entry.sandbox = booted.sandbox;
        entry.facets = booted.facets;
      } catch (error: unknown) {
        live.delete(id);
        throw error;
      }
    },

    async shutdown() {
      if (stopped) {
        return;
      }
      stopped = true;
      await Promise.allSettled([...pending.values(), ...releasing.values()]);
      await Promise.all([...live.values()].map(release));
    },

    async start(spec, signal) {
      assertOpen();
      const constraints = parseSpec(spec);
      const now = Date.now();
      const row: ContainerRow = Object.freeze({
        createdAt: now,
        id: globalThis.crypto.randomUUID(),
        nativeId: undefined,
        spec: JSON.stringify(constraints),
        status: "starting",
        updatedAt: now,
      });
      await store.insert(row);
      return handleFor(await bringUp(row, constraints, signal));
    },
    async sweep(signal) {
      assertOpen();
      const resources = await enumerate(runtime, selection, signal);
      const swept: string[] = [];
      for (const resource of resources) {
        assertNotAborted(signal, "container sweep was cancelled");
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
function nextNativeId(row: ContainerRow): string {
  const previous = Number.parseInt(
    row.nativeId?.slice(row.id.length + 1) ?? "0",
    10
  );
  const generation = (Number.isNaN(previous) ? 0 : previous) + 1;
  return `${row.id}-${String(generation)}`;
}

async function removeNative(
  runtime: ContainerRuntime,
  name: string
): Promise<void> {
  // Best effort: a VM that was already gone is the expected case.
  try {
    await runtime.stopResource(name);
  } catch {
    return;
  }
  try {
    await runtime.removeResource(name);
  } catch {
    // Left for sweep on the next boot.
  }
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
