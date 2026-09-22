/**
 * In-memory {@link ContainerRuntime} for tests. Holds a flat path→bytes map per
 * instance so provider, lease, and facet behaviour can be exercised without a
 * hypervisor.
 */

import type {
  ContainerExecOptions,
  ContainerInstance,
  ContainerProcess,
  ContainerResourceStatus,
  ContainerResourceSummary,
  ContainerRuntime,
  ContainerSpec,
} from "./container/types";
import type {
  SandboxDirectoryEntry,
  SandboxExecResult,
  SandboxShell,
} from "./types";

const TRAILING_SLASHES = /\/+$/;

/** Decides what a command returns. Defaults to a zero-exit no-op. */
export type FakeExecHandler = (
  command: string[],
  options: ContainerExecOptions
) => SandboxExecResult | Promise<SandboxExecResult>;

export interface FakeContainerRuntimeOptions {
  /** Command behaviour. Defaults to exit 0 with empty output. */
  exec?: FakeExecHandler;
  /** Files present in every booted instance, keyed by absolute path. */
  files?: Record<string, string | Uint8Array>;
  /**
   * Behaviour of {@link ContainerRuntime.install}. `"succeeds"` flips
   * `isInstalled` to true; `"fails"` rejects; `"unsupported"` omits the method
   * entirely, as a runtime that cannot self-install would. Default `"succeeds"`.
   */
  install?: "succeeds" | "fails" | "unsupported";
  /** Whether {@link ContainerRuntime.isInstalled} reports the runtime present. Default `true`. */
  installed?: boolean;
  /** Deterministic inventory behaviour for reconciliation tests. */
  inventory?: {
    /** Page size cap applied on top of the query's own limit. */
    pageSize?: number;
    /** 1-based `listResources` call numbers that reject. */
    failListCalls?: readonly number[];
    /** Native names whose stop rejects. */
    failStop?: readonly string[];
    /** Native names whose remove rejects. */
    failRemove?: readonly string[];
  };
  /** Long-lived process behaviour. Omit to keep processes live until signalled. */
  process?: FakeExecHandler;
}

export interface FakeContainerInstance
  extends ContainerInstance<FakeContainerInstance> {
  readonly commands: string[][];
  /** Directories created via {@link ContainerInstance.ensureDirectory}, in order. */
  readonly directories: string[];
  /** Live guest filesystem, so a test can assert on what was written. */
  readonly files: Map<string, Uint8Array>;
  /** Status the inventory reports; writable so tests can script `draining` etc. */
  nativeStatus: ContainerResourceStatus;
  readonly processes: ContainerProcess[];
  removed: boolean;
  readonly spec: ContainerSpec;
  stopped: boolean;
}

export interface FakeContainerRuntime
  extends ContainerRuntime<FakeContainerInstance> {
  create(spec: ContainerSpec): Promise<FakeContainerInstance>;
  /** How many times {@link ContainerRuntime.install} was called. */
  readonly installs: () => number;
  /** Every instance booted through this runtime, in creation order. */
  readonly instances: FakeContainerInstance[];
  /** Labels of every `listResources` call, in order. */
  readonly listed: Readonly<Record<string, string>>[];
}

export function createFakeContainerRuntime(
  options: FakeContainerRuntimeOptions = {}
): FakeContainerRuntime {
  const instances: FakeContainerInstance[] = [];
  const listed: Readonly<Record<string, string>>[] = [];
  const exec: FakeExecHandler =
    options.exec ?? (() => ({ exitCode: 0, stderr: "", stdout: "" }));
  const installMode = options.install ?? "succeeds";
  const inventory = options.inventory ?? {};
  let installed = options.installed ?? true;
  let installs = 0;
  let listCalls = 0;

  const liveByName = (name: string): FakeContainerInstance => {
    const instance = instances.find(
      (candidate) => !candidate.removed && candidate.id === name
    );
    if (instance === undefined) {
      throw new Error(`no sandbox named ${name}`);
    }
    return instance;
  };

  return {
    installs: () => installs,
    instances,
    isInstalled: () => Promise.resolve(installed),
    listed,
    ...(installMode === "unsupported"
      ? {}
      : {
          install: () => {
            installs += 1;
            if (installMode === "fails") {
              return Promise.reject(new Error("download failed"));
            }
            installed = true;
            return Promise.resolve();
          },
        }),
    create(spec) {
      const instance = createInstance(
        spec,
        exec,
        options.process,
        options.files ?? {}
      );
      instances.push(instance);
      return Promise.resolve(instance);
    },
    listResources(query) {
      listed.push(query.labels);
      listCalls += 1;
      if (inventory.failListCalls?.includes(listCalls)) {
        return Promise.reject(new Error("inventory enumeration failed"));
      }
      const matching = instances
        .filter(
          (instance) =>
            !instance.removed &&
            Object.entries(query.labels).every(
              ([key, value]) => instance.spec.labels[key] === value
            )
        )
        .map(
          (instance): ContainerResourceSummary => ({
            labels: instance.spec.labels,
            name: instance.id,
            status: instance.nativeStatus,
          })
        );
      const offset = query.cursor === undefined ? 0 : Number(query.cursor);
      const limit = Math.min(
        query.limit ?? matching.length,
        inventory.pageSize ?? matching.length
      );
      const resources = matching.slice(offset, offset + Math.max(limit, 1));
      const end = offset + resources.length;
      return Promise.resolve({
        resources,
        ...(end < matching.length ? { nextCursor: String(end) } : {}),
      });
    },
    removeResource(name) {
      if (inventory.failRemove?.includes(name)) {
        return Promise.reject(new Error(`remove failed for ${name}`));
      }
      const instance = liveByName(name);
      if (
        instance.nativeStatus === "starting" ||
        instance.nativeStatus === "running" ||
        instance.nativeStatus === "paused" ||
        instance.nativeStatus === "draining"
      ) {
        return Promise.reject(
          new Error(`sandbox ${name} must be stopped before removal`)
        );
      }
      instance.removed = true;
      return Promise.resolve();
    },
    stopResource(name) {
      if (inventory.failStop?.includes(name)) {
        return Promise.reject(new Error(`stop failed for ${name}`));
      }
      const instance = liveByName(name);
      instance.stopped = true;
      instance.nativeStatus = "stopped";
      return Promise.resolve();
    },
  };
}

function createInstance(
  spec: ContainerSpec,
  exec: FakeExecHandler,
  processHandler: FakeExecHandler | undefined,
  seed: Record<string, string | Uint8Array>
): FakeContainerInstance {
  const files = new Map<string, Uint8Array>(
    Object.entries(seed).map(([path, content]) => [path, toBytes(content)])
  );
  const commands: string[][] = [];
  const processes: ContainerProcess[] = [];
  const directories: string[] = [];

  const instance: FakeContainerInstance = {
    commands,
    directories,
    ensureDirectory(path) {
      directories.push(path);
      return Promise.resolve();
    },
    async exec(command, execOptions) {
      commands.push(command);
      return exec(command, execOptions);
    },
    execStream(command): Promise<SandboxShell> {
      commands.push(command);
      const listeners = new Set<(chunk: string) => void>();
      return Promise.resolve({
        close: () => {
          listeners.clear();
          return Promise.resolve();
        },
        onData(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        write(data: string) {
          // Echo, so a terminal test sees something come back.
          for (const listener of listeners) {
            listener(data);
          }
        },
      });
    },
    files,
    get id() {
      return spec.name;
    },
    list(path) {
      const base = path.replace(TRAILING_SLASHES, "");
      const entries = new Map<string, SandboxDirectoryEntry>();
      for (const filePath of [...directories, ...files.keys()]) {
        if (!filePath.startsWith(`${base}/`)) {
          continue;
        }
        const rest = filePath.slice(base.length + 1);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        entries.set(`${base}/${name}`, {
          path: `${base}/${name}`,
          type: slash === -1 && files.has(filePath) ? "file" : "directory",
        });
      }
      return Promise.resolve([...entries.values()]);
    },
    get native() {
      return instance;
    },
    nativeStatus: "running",
    processes,
    readFile(path) {
      const bytes = files.get(path);
      if (!bytes) {
        return Promise.reject(new Error(`No file found at ${path}`));
      }
      return Promise.resolve(new Uint8Array(bytes));
    },
    remove() {
      instance.stopped = true;
      instance.removed = true;
      instance.nativeStatus = "stopped";
      return Promise.resolve();
    },
    removed: false,
    spec,
    startProcess(command, execOptions): Promise<ContainerProcess> {
      commands.push(command);
      let settleManual: ((result: SandboxExecResult) => void) | undefined;
      // Async wrapper so a throwing handler models a runtime whose exec
      // session ends without an exit event: `wait()` rejects.
      const settled =
        processHandler === undefined
          ? new Promise<SandboxExecResult>((resolve) => {
              settleManual = resolve;
            })
          : (async () => processHandler(command, execOptions))();
      let terminated = false;
      const process: ContainerProcess = Object.freeze({
        id: `fake-container-process-${String(processes.length + 1)}`,
        kill: () => {
          if (!terminated) {
            terminated = true;
            settleManual?.({ exitCode: 137, stderr: "", stdout: "" });
          }
          return Promise.resolve();
        },
        signal: () => {
          if (!terminated) {
            terminated = true;
            settleManual?.({
              exitCode: 143,
              stderr: "",
              stdout: "",
            });
          }
          return Promise.resolve();
        },
        wait: () => settled,
      });
      processes.push(process);
      return Promise.resolve(process);
    },
    stat(path) {
      if (files.has(path)) {
        return Promise.resolve("file" as const);
      }
      const prefix = `${path.replace(TRAILING_SLASHES, "")}/`;
      const isDirectory =
        path === "/" ||
        directories.includes(path) ||
        [...directories, ...files.keys()].some((p) => p.startsWith(prefix));
      return Promise.resolve(isDirectory ? ("directory" as const) : undefined);
    },
    stop() {
      instance.stopped = true;
      instance.nativeStatus = "stopped";
      return Promise.resolve();
    },
    stopped: false,
    storage: {
      async lstat(path) {
        const kind = await instance.stat(path);
        if (!kind) {
          throw Object.assign(new Error(`No entry at ${path}`), {
            code: "ENOENT",
          });
        }
        return { type: kind };
      },
      async readDirectory(path) {
        if ((await instance.stat(path)) !== "directory") {
          throw new Error(`Not a directory: ${path}`);
        }
        return (await instance.list(path)).map((entry) => ({
          name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
          type: entry.type,
        }));
      },
      readFile: (path) => instance.readFile(path),
      readLink(path) {
        return Promise.reject(new Error(`Not a symbolic link: ${path}`));
      },
      async realpath(path) {
        if (!(await instance.stat(path))) {
          throw new Error(`No entry at ${path}`);
        }
        return path;
      },
      replaceFile(path, bytes) {
        if (!files.has(path)) {
          return Promise.reject(new Error(`Not a file: ${path}`));
        }
        return instance.writeFile(path, bytes);
      },
      separator: "/",
      writeFile: (path, content) => instance.writeFile(path, toBytes(content)),
    },
    writeFile(path, content) {
      files.set(path, new Uint8Array(content));
      return Promise.resolve();
    },
  };
  return instance;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);
}
