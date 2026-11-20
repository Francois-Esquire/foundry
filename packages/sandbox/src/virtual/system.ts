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
  readonly environment?: Readonly<Record<string, string>>;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly workingDirectory?: string;
}

export interface VirtualSystem extends Sandbox {
  readonly bash: Bash;
  readonly files: SandboxFilesystemFacet & Storage & StorageObserver;
}

export function createVirtualSystem(
  options: VirtualSystemOptions = {}
): VirtualSystem {
  const workdir = normalizeSandboxWorkingDirectory(
    options.workingDirectory ?? DEFAULT_SANDBOX_WORKING_DIRECTORY
  );
  const fs = new ObservableFileSystem(seedFiles(options.files, workdir));
  const bash = new Bash({
    cwd: workdir,
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
  return [file === "" ? "" : singleQuoted(file), rest];
}

function singleQuoted(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
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
