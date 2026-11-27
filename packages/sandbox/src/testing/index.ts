import { ACTIVE_CONTAINER_RESOURCE_STATUSES } from "../containers/defaults";
import type {
  ContainerSpec,
  Driver,
  DriverCapabilities,
  DriverExecOptions,
  DriverHandle,
  DriverProcess,
  DriverResourceStatus,
  DriverResourceSummary,
} from "../containers/driver";
import type {
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxEndpoint,
  SandboxExecResult,
  SandboxPipedProcess,
  SandboxShell,
} from "../sandbox";

const TRAILING_SLASHES = /\/+$/;

export type FakeExecHandler = (
  command: string[],
  options: DriverExecOptions
) => SandboxExecResult | Promise<SandboxExecResult>;

export interface FakeDriverOptions {
  readonly capabilities?: DriverCapabilities;
  readonly connect?: boolean;
  readonly endpointUrl?: (
    ref: string,
    guestPort: number,
    expose?: ContainerSpec["expose"][number]
  ) => SandboxEndpoint | undefined;
  readonly exec?: FakeExecHandler;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly install?: "succeeds" | "fails" | "unsupported";
  readonly installed?: boolean;
  readonly inventory?: {
    readonly disabled?: boolean;
    readonly failListCalls?: readonly number[];
    readonly failRemove?: readonly string[];
    readonly failStop?: readonly string[];
    readonly pageSize?: number;
  };
  readonly opaqueRefPrefix?: string;
  readonly pause?: boolean;
  readonly probePort?: (guestPort: number) => boolean | Promise<boolean>;
  readonly process?: FakeExecHandler;
  readonly shell?: boolean;
  readonly spawn?:
    | false
    | ((
        command: string[],
        options: DriverExecOptions
      ) => SandboxPipedProcess | Promise<SandboxPipedProcess>);
  readonly storage?: boolean;
}

export interface FakeDriverHandle extends DriverHandle<FakeDriverHandle> {
  readonly commands: string[][];
  readonly directories: string[];
  disconnected: boolean;
  readonly files: Map<string, Uint8Array>;
  nativeStatus: DriverResourceStatus;
  paused: boolean;
  readonly processes: DriverProcess[];
  removed: boolean;
  readonly spec: ContainerSpec;
  stopped: boolean;
}

export interface FakeDriver extends Driver<FakeDriverHandle> {
  readonly handles: FakeDriverHandle[];
  readonly installs: () => number;
  readonly listed: Readonly<Record<string, string>>[];
}

export function createFakeDriver(options: FakeDriverOptions = {}): FakeDriver {
  const handles: FakeDriverHandle[] = [];
  const listed: Readonly<Record<string, string>>[] = [];
  const exec: FakeExecHandler =
    options.exec ?? (() => ({ exitCode: 0, stderr: "", stdout: "" }));
  const installMode = options.install ?? "succeeds";
  const inventory = options.inventory ?? {};
  let installed = options.installed ?? true;
  let installs = 0;
  let listCalls = 0;
  let sequence = 0;

  const liveByRef = (ref: string): FakeDriverHandle => {
    const handle = handles.find(
      (candidate) => !candidate.removed && candidate.id === ref
    );
    if (handle === undefined) {
      throw new Error(`no container resource ${ref}`);
    }
    return handle;
  };

  const capabilities: DriverCapabilities = {
    endpoints: ["loopback"],
    lifetime: { idle: true, ttl: true },
    listing: !inventory.disabled,
    mounts: ["host-directory", "volume"],
    network: ["none", "internet", "open", "allowlist"],
    pause: options.pause ?? false,
    reconnect: options.connect ?? false,
    secrets: true,
    ...options.capabilities,
  };

  return {
    capabilities,
    ...(options.connect
      ? {
          connect(ref) {
            const handle = handles.find(
              (candidate) =>
                !(candidate.removed || candidate.stopped) &&
                candidate.id === ref
            );
            if (handle === undefined) {
              return Promise.resolve(undefined);
            }
            handle.disconnected = false;
            return Promise.resolve(handle);
          },
        }
      : {}),
    create({ name, spec }) {
      sequence += 1;
      const ref =
        options.opaqueRefPrefix === undefined
          ? name
          : `${options.opaqueRefPrefix}-${String(sequence)}`;
      const handle = createHandle(ref, spec, exec, options);
      handles.push(handle);
      return Promise.resolve(handle);
    },
    handles,
    inspect(ref) {
      const handle = handles.find(
        (candidate) => !candidate.removed && candidate.id === ref
      );
      return Promise.resolve(handle?.nativeStatus);
    },
    ...(installMode === "unsupported"
      ? {}
      : {
          install() {
            installs += 1;
            if (installMode === "fails") {
              return Promise.reject(new Error("download failed"));
            }
            installed = true;
            return Promise.resolve();
          },
        }),
    installs: () => installs,
    isInstalled: () => Promise.resolve(installed),
    listed,
    ...(inventory.disabled
      ? {}
      : {
          listResources(query) {
            listed.push(query.labels);
            listCalls += 1;
            if (inventory.failListCalls?.includes(listCalls)) {
              return Promise.reject(new Error("inventory enumeration failed"));
            }
            const matching = handles
              .filter(
                (handle) =>
                  !handle.removed &&
                  Object.entries(query.labels).every(
                    ([key, value]) => handle.spec.labels[key] === value
                  )
              )
              .map(
                (handle): DriverResourceSummary => ({
                  labels: handle.spec.labels,
                  name: handle.id,
                  status: handle.nativeStatus,
                })
              );
            const offset =
              query.cursor === undefined ? 0 : Number(query.cursor);
            const limit = Math.min(
              query.limit ?? matching.length,
              inventory.pageSize ?? matching.length
            );
            const resources = matching.slice(
              offset,
              offset + Math.max(limit, 1)
            );
            const end = offset + resources.length;
            return Promise.resolve({
              resources,
              ...(end < matching.length ? { nextCursor: String(end) } : {}),
            });
          },
        }),
    name: "fake",
    ...(options.pause
      ? {
          pauseResource(ref) {
            const handle = liveByRef(ref);
            handle.paused = true;
            handle.nativeStatus = "paused";
            return Promise.resolve();
          },
          resumeResource(ref) {
            const handle = liveByRef(ref);
            if (handle.stopped) {
              return Promise.reject(
                new Error(
                  `container resource ${ref} is stopped and cannot be resumed`
                )
              );
            }
            handle.paused = false;
            handle.nativeStatus = "running";
            return Promise.resolve();
          },
        }
      : {}),
    removeResource(ref) {
      if (inventory.failRemove?.includes(ref)) {
        return Promise.reject(new Error(`remove failed for ${ref}`));
      }
      const handle = liveByRef(ref);
      if (ACTIVE_CONTAINER_RESOURCE_STATUSES.has(handle.nativeStatus)) {
        return Promise.reject(
          new Error(`container ${ref} must be stopped before removal`)
        );
      }
      handle.removed = true;
      return Promise.resolve();
    },
    stopResource(ref) {
      if (inventory.failStop?.includes(ref)) {
        return Promise.reject(new Error(`stop failed for ${ref}`));
      }
      const handle = liveByRef(ref);
      handle.stopped = true;
      handle.nativeStatus = "stopped";
      return Promise.resolve();
    },
  };
}

export function createCloudFakeDriver(
  options: Omit<
    FakeDriverOptions,
    "capabilities" | "connect" | "endpointUrl" | "opaqueRefPrefix" | "pause"
  > = {}
): FakeDriver {
  return createFakeDriver({
    ...options,
    capabilities: {
      endpoints: ["private", "public"],
      lifetime: { idle: true, ttl: true },
      listing: false,
      mounts: ["volume"],
      network: ["none", "internet", "allowlist"],
      pause: true,
      reconnect: true,
      secrets: true,
    },
    connect: true,
    endpointUrl: (ref, guestPort, expose) => {
      const access = expose?.access === "public" ? "public" : "private";
      const protocol = expose?.protocol ?? "https";
      return {
        access,
        ...(access === "private"
          ? { headers: { authorization: `Bearer token-${ref}` } }
          : {}),
        protocol,
        url: `${protocol}://${String(guestPort)}-${ref}.cloud.sandbox.test`,
      };
    },
    inventory: { ...options.inventory, disabled: true },
    opaqueRefPrefix: "sbx",
    pause: true,
    shell: false,
    spawn: false,
    storage: false,
  });
}

function createHandle(
  ref: string,
  spec: ContainerSpec,
  exec: FakeExecHandler,
  options: FakeDriverOptions
): FakeDriverHandle {
  const files = new Map<string, Uint8Array>(
    Object.entries(options.files ?? {}).map(([path, content]) => [
      path,
      toBytes(content),
    ])
  );
  const commands: string[][] = [];
  const processes: DriverProcess[] = [];
  const directories: string[] = [];

  const { probePort, process: processHandler } = options;
  const handle: FakeDriverHandle = {
    commands,
    directories,
    disconnect() {
      handle.disconnected = true;
      return Promise.resolve();
    },
    disconnected: false,
    endpoint(guestPort) {
      const exposed = spec.expose.find((entry) => entry.port === guestPort);
      if (exposed === undefined) {
        return Promise.resolve(undefined);
      }
      if (options.endpointUrl !== undefined) {
        return Promise.resolve(options.endpointUrl(ref, guestPort, exposed));
      }
      const hostPort =
        guestPort <= 25_535 ? 40_000 + guestPort : guestPort - 25_535;
      const protocol = exposed.protocol ?? "http";
      return Promise.resolve({
        access: "loopback",
        host: "127.0.0.1",
        port: hostPort,
        protocol,
        url: `${protocol}://127.0.0.1:${String(hostPort)}`,
      });
    },
    ensureDirectory(path) {
      directories.push(path);
      return Promise.resolve();
    },
    async exec(command: SandboxCommand, execOptions: DriverExecOptions) {
      const argv =
        typeof command === "string" ? ["sh", "-c", command] : [...command];
      commands.push(argv);
      return exec(argv, execOptions);
    },
    ...(options.shell === false
      ? {}
      : {
          execStream(
            command: SandboxCommand | undefined
          ): Promise<SandboxShell> {
            let argv: string[];
            if (command === undefined) {
              argv = ["/bin/sh"];
            } else if (typeof command === "string") {
              argv = ["sh", "-c", command];
            } else {
              argv = [...command];
            }
            commands.push(argv);
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
                for (const listener of listeners) {
                  listener(data);
                }
              },
            });
          },
        }),
    files,
    get id() {
      return ref;
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
      return handle;
    },
    nativeStatus: "running",
    ...(options.pause
      ? {
          pause() {
            handle.paused = true;
            handle.nativeStatus = "paused";
            return Promise.resolve();
          },
          resume() {
            handle.paused = false;
            handle.nativeStatus = "running";
            return Promise.resolve();
          },
        }
      : {}),
    paused: false,
    ...(probePort === undefined
      ? {}
      : {
          probePort: (port: number) => Promise.resolve(probePort(port)),
        }),
    processes,
    readFile(path) {
      const bytes = files.get(path);
      if (!bytes) {
        return Promise.reject(new Error(`No file found at ${path}`));
      }
      return Promise.resolve(new Uint8Array(bytes));
    },
    remove() {
      handle.stopped = true;
      handle.removed = true;
      handle.nativeStatus = "stopped";
      return Promise.resolve();
    },
    removed: false,
    ...(options.spawn === false
      ? {}
      : {
          async spawn(command: SandboxCommand, execOptions: DriverExecOptions) {
            execOptions.signal?.throwIfAborted();
            if (typeof options.spawn !== "function") {
              throw new Error("No piped process fixture configured");
            }
            const argv =
              typeof command === "string"
                ? ["sh", "-c", command]
                : [...command];
            commands.push(argv);
            return options.spawn(argv, execOptions);
          },
        }),
    spec: { ...spec, labels: { ...spec.labels } },
    startProcess(
      command: SandboxCommand,
      execOptions: DriverExecOptions
    ): Promise<DriverProcess> {
      const argv =
        typeof command === "string" ? ["sh", "-c", command] : [...command];
      commands.push(argv);
      let settleManual: ((result: SandboxExecResult) => void) | undefined;
      const settled =
        processHandler === undefined
          ? new Promise<SandboxExecResult>((resolve) => {
              settleManual = resolve;
            })
          : (async () => processHandler(argv, execOptions))();
      let terminated = false;
      const proc: DriverProcess = Object.freeze({
        id: `fake-process-${String(processes.length + 1)}`,
        kill: () => {
          if (!terminated) {
            terminated = true;
            settleManual?.({ exitCode: 137, stderr: "", stdout: "" });
          }
          return Promise.resolve();
        },
        terminate: () => {
          if (!terminated) {
            terminated = true;
            settleManual?.({ exitCode: 143, stderr: "", stdout: "" });
          }
          return Promise.resolve();
        },
        wait: () => settled,
      });
      processes.push(proc);
      return Promise.resolve(proc);
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
      handle.stopped = true;
      handle.nativeStatus = "stopped";
      return Promise.resolve();
    },
    stopped: false,
    ...(options.storage === false
      ? {}
      : {
          storage: {
            async lstat(path) {
              const kind = await handle.stat(path);
              if (!kind) {
                throw Object.assign(new Error(`No entry at ${path}`), {
                  code: "ENOENT",
                });
              }
              return { type: kind };
            },
            async readDirectory(path) {
              if ((await handle.stat(path)) !== "directory") {
                throw new Error(`Not a directory: ${path}`);
              }
              return (await handle.list(path)).map((entry) => ({
                name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
                type: entry.type,
              }));
            },
            readFile: (path) => handle.readFile(path),
            readLink(path) {
              return Promise.reject(new Error(`Not a symbolic link: ${path}`));
            },
            async realpath(path) {
              if (!(await handle.stat(path))) {
                throw new Error(`No entry at ${path}`);
              }
              return path;
            },
            replaceFile(path, bytes) {
              if (!files.has(path)) {
                return Promise.reject(new Error(`Not a file: ${path}`));
              }
              return handle.writeFile(path, bytes);
            },
            separator: "/",
            writeFile: (path, content) =>
              handle.writeFile(path, toBytes(content)),
          },
        }),
    unmount: () => Promise.resolve(),
    writeFile(path, content) {
      files.set(path, new Uint8Array(content));
      return Promise.resolve();
    },
  };
  return handle;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);
}
