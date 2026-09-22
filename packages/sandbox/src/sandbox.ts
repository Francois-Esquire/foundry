import type { StorageReader, StorageWriter } from "@foundry/core/storage";
import { SandboxError } from "./errors";
import { normalizeSandboxPath } from "./path";
import type {
  Sandbox,
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxFilesystemFacet,
  SandboxListOptions,
} from "./types";

/** What a backend supplies; every path it receives is already normalized. */
export interface SandboxAdapter
  extends Pick<StorageReader, "readFile">,
    StorageWriter {
  copyIn(files: Readonly<Record<string, string | Uint8Array>>): Promise<void>;
  copyOut(path: string): Promise<Readonly<Record<string, Uint8Array>>>;
  exec(
    command: string | string[],
    options?: SandboxExecOptions
  ): Promise<SandboxExecResult>;
  isDirectory(path: string): Promise<boolean>;
  list(
    path: string,
    recursive: boolean
  ): Promise<readonly SandboxDirectoryEntry[]>;
  readonly workingDirectory: string;
}

function normalizedExecOptions(
  options: SandboxExecOptions | undefined,
  workingDirectory: string
): SandboxExecOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...(options.cwd === undefined
      ? {}
      : { cwd: normalizeSandboxPath(options.cwd, workingDirectory) }),
    ...(options.environment === undefined
      ? {}
      : { environment: { ...options.environment } }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/** A {@link Sandbox} over a backend, with path normalization in one place. */
export function sandboxFromAdapter(adapter: SandboxAdapter): Sandbox {
  const { workingDirectory } = adapter;
  const at = (path: string): string =>
    normalizeSandboxPath(path, workingDirectory);
  const files: SandboxFilesystemFacet = Object.freeze({
    copyIn: (contents: Readonly<Record<string, string | Uint8Array>>) =>
      Promise.resolve().then(() =>
        adapter.copyIn(
          Object.fromEntries(
            Object.entries(contents).map(([path, content]) => [
              at(path),
              content,
            ])
          )
        )
      ),
    copyOut: (path: string) =>
      Promise.resolve().then(() => adapter.copyOut(at(path))),
    isDirectory: (path: string) =>
      Promise.resolve().then(() => adapter.isDirectory(at(path))),
    list: (path: string, options?: SandboxListOptions) =>
      Promise.resolve().then(() =>
        adapter.list(at(path), options?.recursive ?? false)
      ),
    readFile: (path: string) =>
      Promise.resolve().then(() => adapter.readFile(at(path))),
    writeFile: (path: string, content: string | Uint8Array) =>
      Promise.resolve().then(() => adapter.writeFile(at(path), content)),
  });
  return Object.freeze({
    commands: Object.freeze({
      exec: (command: SandboxCommand, options?: SandboxExecOptions) =>
        Promise.resolve().then(() =>
          adapter.exec(
            typeof command === "string" ? command : [...command],
            normalizedExecOptions(options, workingDirectory)
          )
        ),
    }),
    files,
    workingDirectory,
  });
}

/** Raises the shared cancellation error while preserving backend-specific context. */
export function assertNotAborted(
  signal: AbortSignal | undefined,
  message: string,
  details?: Readonly<Record<string, unknown>>
): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw new SandboxError(
    "cancelled",
    message,
    details === undefined ? {} : { details }
  );
}
