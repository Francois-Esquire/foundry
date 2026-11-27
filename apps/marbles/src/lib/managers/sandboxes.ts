import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Container,
  ContainerSpecInput,
  Containers,
} from "@foundry/sandbox";
import {
  DEFAULT_SANDBOX_WORKING_DIRECTORY,
  SandboxError,
} from "@foundry/sandbox";

import type { ManagerArgs } from "../bindings";
import { workingDirectory } from "../run-scope";
import type {
  ImageSandbox,
  SandboxDefinition,
  Sandboxes,
  SandboxHandle,
  SandboxSpec,
} from "../types";

type WorkspaceMaterializer = (
  container: Container,
  input: { readonly source: string; readonly target: string }
) => Promise<void>;

export type WorkspaceMaterialization = "bind" | "none" | WorkspaceMaterializer;

export interface SandboxesDeps {
  readonly containers: () => Promise<Containers>;
  readonly root: string;
  readonly workspaceMaterialization?: WorkspaceMaterialization;
}

const WORKSPACE_TARGET = DEFAULT_SANDBOX_WORKING_DIRECTORY;
const KIND = "sandboxes.start";

export interface MountDirs {
  readonly cwd: string;
  readonly root: string;
}

function mountSource(spec: ImageSandbox, dirs: MountDirs): string {
  if (spec.mount === undefined || spec.mount === "." || spec.mount === "none") {
    return dirs.cwd;
  }
  return resolve(dirs.root, spec.mount.path);
}

export function guestFiles(
  files: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path.startsWith("/") ? path : `${WORKSPACE_TARGET}/${path}`,
      content,
    ])
  );
}

export function allowedMountRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].filter((dir) =>
    existsSync(dir)
  );
}

export function constraintsFor(
  spec: SandboxSpec,
  dirs: MountDirs,
  options?: { readonly bindWorkspace?: boolean }
): ContainerSpecInput {
  const target =
    ("target" in spec ? spec.target : undefined) ?? WORKSPACE_TARGET;
  const passed = Object.fromEntries(
    PASSED_THROUGH.flatMap((key) =>
      spec[key] === undefined ? [] : [[key, spec[key]]]
    )
  );
  const shouldBind =
    !("files" in spec) &&
    spec.mount !== "none" &&
    (options?.bindWorkspace ?? true);
  return {
    ...passed,
    mounts: shouldBind
      ? [
          {
            access: "read-write" as const,
            executable: spec.executable ?? false,
            id: "workspace",
            source: {
              kind: "host-directory" as const,
              path: mountSource(spec, dirs),
            },
            target,
          },
        ]
      : [],
    workdir: spec.workdir ?? target,
  };
}

const PASSED_THROUGH = [
  "expose",
  "image",
  "labels",
  "lifetime",
  "network",
  "publicEnvironment",
  "resources",
  "secrets",
] as const satisfies readonly (keyof SandboxSpec)[];

interface HandleSite {
  readonly close?: () => Promise<void>;
  readonly signal: () => AbortSignal | undefined;
  readonly write?: (value: unknown) => void;
}

function withSignal<O extends { readonly signal?: AbortSignal }>(
  options: O | undefined,
  site: HandleSite
): O & { signal?: AbortSignal } {
  const owned = site.signal();
  const given = options?.signal;
  const signal =
    owned && given ? AbortSignal.any([owned, given]) : (owned ?? given);
  signal?.throwIfAborted();
  return { ...(options as O), ...(signal ? { signal } : {}) };
}

function wrap(container: Container, site: HandleSite): SandboxHandle {
  const exec: SandboxHandle["exec"] = async (command, options) => {
    const result = await container.commands.exec(
      command,
      withSignal(options, site)
    );
    if (site.write) {
      const shown = typeof command === "string" ? command : command.join(" ");
      site.write(`$ ${shown}\n${result.stdout}${result.stderr}`);
    }
    return result;
  };
  const containerProcesses = container.processes;
  const containerSpawn = containerProcesses?.spawn;
  const processes: SandboxHandle["processes"] =
    containerProcesses === undefined
      ? undefined
      : {
          ...(containerSpawn === undefined
            ? {}
            : {
                spawn: (command, options) =>
                  containerSpawn(command, withSignal(options, site)),
              }),
          start: (command, options) =>
            containerProcesses.start(command, withSignal(options, site)),
        };
  const overrides: Record<PropertyKey, unknown> = {
    ...(site.close ? { close: site.close } : {}),
    commands: { exec },
    exec,
    ...(processes === undefined ? {} : { processes }),
  };
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "row") {
          return;
        }
        if (Object.hasOwn(overrides, property)) {
          return overrides[property];
        }
        const value = Reflect.get(container, property, container);
        return typeof value === "function" ? value.bind(container) : value;
      },
      has: (_target, property) =>
        property !== "row" &&
        (Object.hasOwn(overrides, property) || property in container),
    }
  ) as SandboxHandle;
}

async function closeAfterFailure(
  error: unknown,
  container: Container
): Promise<never> {
  const [closed] = await Promise.allSettled([container.close()]);
  if (closed.status === "rejected") {
    throw new AggregateError(
      [error, closed.reason],
      `${errorMessage(error)}\nSandbox cleanup also failed: ${errorMessage(closed.reason)}`,
      { cause: error }
    );
  }
  throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SandboxesManager implements Sandboxes {
  readonly #deps: SandboxesDeps;
  readonly #handles = new WeakMap<SandboxHandle, Container>();
  readonly #started = new Set<string>();
  #opened: Promise<Containers> | undefined;

  constructor(deps: SandboxesDeps) {
    this.#deps = deps;
  }

  containerOf(sandbox: SandboxHandle): Container {
    const container = this.#handles.get(sandbox);
    if (!container) {
      throw new Error("The sandbox must be opened by this engine.");
    }
    return container;
  }

  #handle(container: Container, site: HandleSite) {
    const handle = wrap(container, site);
    this.#handles.set(handle, container);
    return handle;
  }

  containers(): Promise<Containers> {
    this.#opened ??= this.#deps.containers();
    return this.#opened;
  }

  async #open(id: string, signal?: AbortSignal): Promise<Container> {
    const containers = await this.containers();
    return containers.open(id, signal);
  }

  async #start(
    sandbox: SandboxDefinition | SandboxSpec,
    signal?: AbortSignal
  ): Promise<Container> {
    const { root, workspaceMaterialization } = this.#deps;
    const containers = await this.containers();
    const dirs = { cwd: workingDirectory(root), root };
    const driverSupportsBind =
      containers.capabilities.mounts === undefined ||
      containers.capabilities.mounts.includes("host-directory");
    const bindWorkspace =
      workspaceMaterialization === undefined
        ? driverSupportsBind
        : workspaceMaterialization === "bind";
    if (
      !("files" in sandbox) &&
      sandbox.mount !== "none" &&
      !bindWorkspace &&
      typeof workspaceMaterialization !== "function"
    ) {
      throw new SandboxError(
        "unsupported",
        "driver does not support host-directory mounts and no workspaceMaterialization callback is configured"
      );
    }
    const container = await containers.start(
      constraintsFor(sandbox, dirs, { bindWorkspace }),
      signal
    );
    if ("files" in sandbox) {
      await container.files
        .copyIn(guestFiles(sandbox.files))
        .catch((error: unknown) => closeAfterFailure(error, container));
    } else if (
      typeof workspaceMaterialization === "function" &&
      sandbox.mount !== "none"
    ) {
      const target = sandbox.target ?? WORKSPACE_TARGET;
      await workspaceMaterialization(container, {
        source: mountSource(sandbox, dirs),
        target,
      }).catch((error: unknown) => closeAfterFailure(error, container));
    }
    this.#started.add(container.id);
    return container;
  }

  adopt(container: Container, signal?: AbortSignal): SandboxHandle {
    return this.#handle(container, {
      close: () => Promise.resolve(),
      signal: () => signal,
    });
  }

  async open(id: string): Promise<SandboxHandle> {
    return this.#handle(await this.#open(id), { signal: () => undefined });
  }

  async start(
    sandbox: SandboxDefinition | SandboxSpec
  ): Promise<SandboxHandle> {
    return this.#handle(await this.#start(sandbox), {
      signal: () => undefined,
    });
  }

  scoped({ frame, scope, write }: ManagerArgs): Sandboxes {
    const attach = (container: Container): SandboxHandle => {
      const handle = this.#handle(container, {
        signal: () => frame.signal,
        write,
      });
      frame.opened.add(handle);
      return handle;
    };
    return {
      open: async (id) => attach(await this.#open(id, frame.signal)),
      start: async (sandbox) => {
        const { key } = scope.claim(frame, KIND);
        await this.containers();
        const recorded = scope.ledger.get<string>(key);
        if (recorded !== undefined && this.#started.has(recorded)) {
          try {
            return attach(await this.#open(recorded, frame.signal));
          } catch {
            scope.ledger.set(key, undefined);
          }
        }
        const container = await this.#start(sandbox, frame.signal);
        scope.ledger.set(key, container.id);
        return attach(container);
      },
    };
  }

  async close(): Promise<void> {
    await this.#opened?.then((containers) => containers.shutdown());
  }
}
