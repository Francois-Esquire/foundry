import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox/constants";
import { SandboxError } from "@foundry/sandbox/errors";
import { normalizeSandboxPath } from "@foundry/sandbox/path";
import { sandboxFromAdapter } from "@foundry/sandbox/sandbox";
import type {
  Sandbox,
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxExecOptions,
} from "@foundry/sandbox/types";

export interface FakeSandboxCommandCall {
  readonly command: SandboxCommand;
  readonly options?: SandboxExecOptions;
}

export interface FakeSandboxCommandScript {
  readonly command: SandboxCommand;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stdout?: string;
  /** Files the command leaves behind, relative to its cwd. */
  readonly writes?: Readonly<Record<string, string | Uint8Array>>;
}

export interface FakeSandboxOptions {
  readonly commands?: readonly FakeSandboxCommandScript[];
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
}

export interface FakeSandbox {
  readonly commandCalls: readonly FakeSandboxCommandCall[];
  readonly sandbox: Sandbox;
}

const encoder = new TextEncoder();

function bytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? encoder.encode(content)
    : new Uint8Array(content);
}

function commandMatches(
  command: SandboxCommand,
  candidate: SandboxCommand
): boolean {
  if (typeof command === "string" || typeof candidate === "string") {
    return command === candidate;
  }
  return (
    command.length === candidate.length &&
    command.every((part, index) => part === candidate[index])
  );
}

/** In-memory Sandbox whose commands are scripted, not run. */
export function createFakeSandbox(
  options: FakeSandboxOptions = {}
): FakeSandbox {
  const workingDirectory = DEFAULT_SANDBOX_WORKING_DIRECTORY;
  const storedFiles = new Map<string, Uint8Array>();
  const directories = new Set<string>(["/", workingDirectory]);
  const commandCalls: FakeSandboxCommandCall[] = [];

  const store = (path: string, content: string | Uint8Array): void => {
    storedFiles.set(path, bytes(content));
    let directory = path.slice(0, path.lastIndexOf("/")) || "/";
    for (;;) {
      directories.add(directory);
      if (directory === "/") {
        return;
      }
      const slash = directory.lastIndexOf("/");
      directory = slash === 0 ? "/" : directory.slice(0, slash);
    }
  };

  for (const [path, content] of Object.entries(options.files ?? {})) {
    store(normalizeSandboxPath(path, workingDirectory), content);
  }

  const sandbox = sandboxFromAdapter({
    copyIn(incoming) {
      for (const [path, content] of Object.entries(incoming)) {
        store(path, content);
      }
      return Promise.resolve();
    },
    copyOut(path) {
      const prefix = `${path}/`;
      const output: Record<string, Uint8Array> = {};
      for (const [candidate, content] of storedFiles) {
        if (candidate === path || candidate.startsWith(prefix)) {
          output[candidate] = new Uint8Array(content);
        }
      }
      return Promise.resolve(Object.freeze(output));
    },
    exec(command, execOptions) {
      if (execOptions?.signal?.aborted === true) {
        throw new SandboxError("cancelled", "sandbox command was cancelled");
      }
      commandCalls.push({
        command,
        ...(execOptions === undefined ? {} : { options: execOptions }),
      });
      const script = options.commands?.find((candidate) =>
        commandMatches(command, candidate.command)
      );
      if (script === undefined) {
        return Promise.resolve({
          exitCode: 127,
          stderr: "fake sandbox command not scripted",
          stdout: "",
        });
      }
      const base = execOptions?.cwd ?? workingDirectory;
      for (const [path, content] of Object.entries(script.writes ?? {})) {
        store(normalizeSandboxPath(path, base), content);
      }
      return Promise.resolve({
        exitCode: script.exitCode ?? 0,
        stderr: script.stderr ?? "",
        stdout: script.stdout ?? "",
      });
    },
    isDirectory(path) {
      return Promise.resolve(directories.has(path));
    },
    list(path, recursive) {
      const prefix = path === "/" ? "/" : `${path}/`;
      // Only file paths are stored, so directories are inferred from the
      // segments between the listed path and each file under it.
      const entries = new Map<string, SandboxDirectoryEntry>();
      for (const candidate of storedFiles.keys()) {
        if (!candidate.startsWith(prefix)) {
          continue;
        }
        const segments = candidate.slice(prefix.length).split("/");
        if (segments.length > 1 && !recursive) {
          const child = `${prefix}${String(segments[0])}`;
          entries.set(child, { path: child, type: "directory" });
          continue;
        }
        for (let depth = 1; depth < segments.length; depth += 1) {
          const child = `${prefix}${segments.slice(0, depth).join("/")}`;
          entries.set(child, { path: child, type: "directory" });
        }
        entries.set(candidate, { path: candidate, type: "file" });
      }
      return Promise.resolve([...entries.values()]);
    },
    readFile(path) {
      const content = storedFiles.get(path);
      if (content === undefined) {
        throw new SandboxError(
          "provider-failed",
          `sandbox file does not exist: ${path}`,
          { details: { path } }
        );
      }
      return Promise.resolve(new Uint8Array(content));
    },
    workingDirectory,
    writeFile(path, content) {
      store(path, content);
      return Promise.resolve();
    },
  });

  return { commandCalls, sandbox };
}
