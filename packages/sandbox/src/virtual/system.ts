/**
 * The virtual system: an execution environment that is a simulated machine
 * running entirely inside this process. No container, no daemon, no directory
 * on disk — a `just-bash` interpreter over an in-memory filesystem, which
 * means it starts in microseconds and disappears when nothing references it.
 *
 * It binds the same two facets every other provider does, so the sandbox
 * toolkit runs on it unchanged. An agent given a virtual system reads, writes,
 * edits, greps, globs, and runs commands exactly as it would in a container;
 * the only thing that differs is that none of it survives the process.
 *
 * What it is for: firing off an environment immediately — a scratch space for
 * a tool an agent is composing, a test that needs a real shell without Docker,
 * a place to run something untrusted where "untrusted" means "we do not want
 * it touching the machine at all". The simulator implements the commands
 * itself, so there is no host process to escape into.
 *
 * What it is NOT: a security boundary for the code *hosting* it, a place to
 * run real binaries, or anywhere durable. `just-bash` simulates a broad
 * toolbox — grep, sed, awk, find, jq, tar, sqlite3 and more — but it is a
 * simulation, and a command it does not implement simply is not there.
 */

import type { Storage, StorageObserver } from "@foundry/core/storage";
import type { IFileSystem } from "just-bash";
import { Bash } from "just-bash";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "../constants";

import { SandboxError } from "../errors";
import {
  normalizeSandboxPath,
  normalizeSandboxWorkingDirectory,
} from "../path";
import type {
  Sandbox,
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxFilesystemFacet,
  SandboxListOptions,
} from "../types";
import { ObservableFileSystem } from "./filesystem";

export interface VirtualSystemOptions {
  /** Environment variables every command sees. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Files present the moment it starts. Relative paths resolve against the
   *  working directory. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  /** Where the environment starts. Defaults to `/workspace`, as everywhere
   *  else in this package. */
  readonly workingDirectory?: string;
}

/** An in-memory {@link Sandbox}, plus the interpreter underneath for anything
 *  files and commands do not cover. */
export interface VirtualSystem extends Sandbox {
  readonly bash: Bash;
  readonly files: SandboxFilesystemFacet & Storage & StorageObserver;
}

/**
 * Build one and use it immediately — no lifecycle, no provisioning:
 *
 * ```ts
 * const system = createVirtualSystem({ files: { "notes.md": "hello" } });
 * const { tools } = createSandboxToolkit(system);
 * ```
 */
export function createVirtualSystem(
  options: VirtualSystemOptions = {}
): VirtualSystem {
  const workdir = normalizeSandboxWorkingDirectory(
    options.workingDirectory ?? DEFAULT_SANDBOX_WORKING_DIRECTORY
  );
  const fs = new ObservableFileSystem(seedFiles(options.files, workdir));
  const bash = new Bash({
    cwd: workdir,
    // The guard patches Node's `Module._resolveFilename`, which Bun does not
    // have, and treats that as a critical failure: every command then errors.
    // It is a secondary layer by the library's own account; the simulator is
    // the actual boundary, so it is off under Bun and capability-detected
    // everywhere else.
    defenseInDepth: {
      enabled: process.versions.bun === undefined ? "auto" : false,
    },
    fs,
    ...(options.environment === undefined
      ? {}
      : { env: { ...options.environment } }),
  });
  return Object.freeze({
    bash,
    commands: Object.freeze({
      exec: (command: SandboxCommand, execOptions?: SandboxExecOptions) =>
        virtualExec(bash, workdir, command, execOptions),
    }),
    files: virtualFilesystemFacet(fs, workdir),
    workingDirectory: workdir,
  });
}

function virtualFilesystemFacet(
  fs: ObservableFileSystem,
  workdir: string
): SandboxFilesystemFacet & Storage & StorageObserver {
  const at = (path: string): string => normalizeSandboxPath(path, workdir);

  async function write(
    path: string,
    content: string | Uint8Array
  ): Promise<void> {
    const target = at(path);
    const parent = target.slice(0, target.lastIndexOf("/")) || "/";
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(
      target,
      typeof content === "string" ? content : new Uint8Array(content)
    );
  }

  async function read(target: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await fs.readFileBuffer(target));
    } catch (error: unknown) {
      // biome-ignore lint/style/useErrorCause: SandboxError accepts ErrorOptions as its third argument.
      throw new SandboxError(
        "provider-failed",
        `virtual file is not readable: ${target}`,
        { cause: error }
      );
    }
  }

  return Object.freeze({
    async copyIn(
      files: Readonly<Record<string, string | Uint8Array>>
    ): Promise<void> {
      for (const [path, content] of Object.entries(files)) {
        await write(path, content);
      }
    },
    async copyOut(path: string): Promise<Readonly<Record<string, Uint8Array>>> {
      const target = at(path);
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink) {
        return {};
      }
      if (stats.isFile) {
        return { [target]: await read(target) };
      }
      const output: Record<string, Uint8Array> = {};
      for await (const entry of walk(fs, target, true)) {
        if (entry.type !== "file") {
          continue;
        }
        output[entry.path] = await read(entry.path);
      }
      return Object.freeze(output);
    },
    async isDirectory(path: string): Promise<boolean> {
      const stat = await fs.lstat(at(path)).catch(() => null);
      return stat?.isDirectory === true;
    },
    async list(
      path: string,
      options?: SandboxListOptions
    ): Promise<readonly SandboxDirectoryEntry[]> {
      const found: SandboxDirectoryEntry[] = [];
      for await (const entry of walk(
        fs,
        at(path),
        options?.recursive ?? false
      )) {
        found.push(entry);
      }
      return found;
    },
    async lstat(path: string) {
      const stats = await fs.lstat(at(path));
      return {
        type: storageEntryType(stats),
      };
    },
    async readDirectory(path: string) {
      const target = await fs.realpath(at(path));
      const names = await fs.readdir(target);
      return Promise.all(
        names.map(async (name) => {
          const stats = await fs.lstat(`${target}/${name}`);
          return {
            name,
            type: storageEntryType(stats),
          };
        })
      );
    },
    readFile(path: string): Promise<Uint8Array> {
      return read(at(path));
    },
    readLink: (path: string) => fs.readlink(at(path)),
    realpath: (path: string) => fs.realpath(at(path)),
    async replaceFile(path: string, bytes: Uint8Array): Promise<void> {
      const target = at(path);
      const stats = await fs.lstat(target);
      if (!stats.isFile || stats.isSymbolicLink) {
        throw new SandboxError(
          "invalid-contract",
          `Cannot replace a non-regular file: ${target}`,
          { details: { path: target } }
        );
      }
      const resolved = await fs.realpath(target);
      const slash = resolved.lastIndexOf("/");
      const temp = `${resolved.slice(0, slash)}/.${resolved.slice(slash + 1)}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, new Uint8Array(bytes));
        await fs.chmod(temp, stats.mode);
        // The default in-memory filesystem swaps file entries synchronously in mv.
        await fs.mv(temp, resolved);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    separator: "/" as const,
    watch: (root: string, changed: () => void) => fs.watch(at(root), changed),
    writeFile(path: string, content: string | Uint8Array): Promise<void> {
      return write(path, content);
    },
  });
}

/**
 * Enumerate a directory, one level or all the way down.
 *
 * Degrades rather than throws, per the facet contract: a path that is not a
 * readable directory yields nothing, so a scan over a partly built tree keeps
 * going. Symlinks are listed without traversal — `lstat`, not `stat`, so a link loop
 * cannot turn a recursive walk into an infinite one.
 */
async function* walk(
  fs: IFileSystem,
  dir: string,
  recursive: boolean
): AsyncGenerator<SandboxDirectoryEntry> {
  const root = await fs.lstat(dir).catch(() => null);
  if (!root?.isDirectory || root.isSymbolicLink) {
    return;
  }
  const names = await fs.readdir(dir).catch(() => null);
  if (!names) {
    return;
  }
  for (const name of names) {
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const stat = await fs.lstat(path).catch(() => null);
    if (!stat) {
      continue;
    }
    if (stat.isSymbolicLink) {
      yield { path, type: "symlink" };
    } else if (stat.isDirectory) {
      yield { path, type: "directory" };
      if (recursive) {
        yield* walk(fs, path, true);
      }
    } else if (stat.isFile) {
      yield { path, type: "file" };
    }
  }
}

/** Seed paths resolve against the working directory, so a caller can pass
 *  `{"src/app.ts": …}` the way it does to every other provider. */
function seedFiles(
  files: Readonly<Record<string, string | Uint8Array>> | undefined,
  workdir: string
): Record<string, string | Uint8Array> {
  const seeded: Record<string, string | Uint8Array> = {};
  for (const [path, content] of Object.entries(files ?? {})) {
    seeded[normalizeSandboxPath(path, workdir)] = content;
  }
  return seeded;
}

/**
 * Run one command in the simulator.
 *
 * The two command shapes stay genuinely distinct, which is the contract every
 * provider owes. A string is a shell line and is parsed as one. An array is
 * argv and rides `just-bash`'s own `args` channel, which bypasses shell
 * parsing entirely — so an argument containing a space, a quote, or a `$` is
 * one argument, and no host-side quoting is invented to make that true.
 */
async function virtualExec(
  bash: Bash,
  workdir: string,
  command: SandboxCommand,
  options?: SandboxExecOptions
): Promise<SandboxExecResult> {
  if (options?.signal?.aborted === true) {
    throw new SandboxError("cancelled", "virtual system command was cancelled");
  }
  const [line, args] = toExecArgs(command);
  if (line === "") {
    throw new SandboxError(
      "invalid-contract",
      "sandbox command must not be empty"
    );
  }
  const result = await bash.exec(line, {
    cwd:
      options?.cwd === undefined
        ? workdir
        : normalizeSandboxPath(options.cwd, workdir),
    ...(options?.environment === undefined
      ? {}
      : { env: { ...options.environment } }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(args === undefined ? {} : { args }),
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function toExecArgs(command: SandboxCommand): [string, string[] | undefined] {
  if (typeof command === "string") {
    return [command.trim(), undefined];
  }
  const [file = "", ...rest] = command;
  return [file, rest];
}

function storageEntryType(stats: {
  isSymbolicLink: boolean;
  isDirectory: boolean;
  isFile: boolean;
}): "symlink" | "directory" | "file" | "unknown" {
  if (stats.isSymbolicLink) {
    return "symlink";
  }
  if (stats.isDirectory) {
    return "directory";
  }
  if (stats.isFile) {
    return "file";
  }
  return "unknown";
}
