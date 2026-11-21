import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Container } from "@foundry/sandbox/container/containers";
import type {
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxExecOptions,
  SandboxListOptions,
} from "@foundry/sandbox/types";
import { MODULE_SANDBOX_ROOT } from "../sandboxes/coordinator";

export const AUTHORING_GUEST_USER = "bun";

type GuestFiles = Pick<Container, "commands" | "files">;

const UNAVAILABLE = "Not available to an authoring agent";

const ENTRY_TYPES: Readonly<Record<string, SandboxDirectoryEntry["type"]>> = {
  b: "device",
  c: "device",
  d: "directory",
  f: "file",
  l: "symlink",
  p: "pipe",
  s: "socket",
};

export function authoringGuest(container: Container): Container {
  const refuse = () => Promise.reject(new Error(UNAVAILABLE));
  const asGuest = (options: SandboxExecOptions = {}) => ({
    ...options,
    user: AUTHORING_GUEST_USER,
  });
  const exec = (command: SandboxCommand, options?: SandboxExecOptions) =>
    container.commands.exec(command, asGuest(options));
  const at = (path: string) => posix.resolve(container.workingDirectory, path);
  async function succeeded(
    command: readonly string[],
    failure: string
  ): Promise<string> {
    const result = await exec([...command]);
    if (result.exitCode !== 0) {
      throw new Error(`${failure}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }
  async function write(path: string, content: string | Uint8Array) {
    const staged = `/tmp/works-write-${randomUUID()}`;
    await container.files.writeFile(staged, content);
    try {
      await succeeded(
        [
          "sh",
          "-c",
          'mkdir -p -- "$(dirname -- "$2")" && cp -- "$1" "$2"',
          "write",
          staged,
          at(path),
        ],
        `${path} could not be written`
      );
    } finally {
      await container.commands.exec(["rm", "-f", "--", staged]);
    }
  }
  async function readFile(path: string): Promise<Uint8Array> {
    const encoded = await succeeded(
      ["base64", "--", at(path)],
      `${path} could not be read`
    );
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }
  async function list(
    path: string,
    options: SandboxListOptions = {}
  ): Promise<readonly SandboxDirectoryEntry[]> {
    const listed = await exec([
      "find",
      "-P",
      at(path),
      "-mindepth",
      "1",
      ...(options.recursive ? [] : ["-maxdepth", "1"]),
      "-printf",
      "%y %p\\0",
    ]);
    return listed.stdout
      .split("\0")
      .filter(Boolean)
      .map((line) => ({
        path: line.slice(2),
        type: ENTRY_TYPES[line.charAt(0)] ?? "unknown",
      }));
  }
  return {
    close: () => container.close(),
    commands: { exec },
    files: {
      async copyIn(files) {
        for (const [path, content] of Object.entries(files)) {
          await write(path, content);
        }
      },
      copyOut: refuse,
      isDirectory: async (path) =>
        (await exec(["test", "-d", at(path)])).exitCode === 0,
      list,
      lstat: refuse,
      readDirectory: refuse,
      readFile,
      readLink: refuse,
      realpath: async (path) =>
        (
          await succeeded(
            ["realpath", "-e", "--", at(path)],
            `${path} could not be resolved`
          )
        ).trimEnd(),
      replaceFile: (path, bytes, expectedDigest) =>
        expectedDigest === undefined ? write(path, bytes) : refuse(),
      separator: "/",
      watch: refuse,
      writeFile: write,
    },
    id: container.id,
    ports: { hostPort: refuse },
    processes: {
      spawn: (command, options) =>
        container.processes.spawn(command, asGuest(options)),
      start: (command, options) =>
        container.processes.start(command, asGuest(options)),
    },
    get row() {
      return container.row;
    },
    services: {
      list: () => Promise.resolve([]),
      start: refuse,
      stop: refuse,
    },
    shell: { open: refuse },
    workingDirectory: container.workingDirectory,
  };
}

export async function endAuthoringProcesses(
  container: GuestFiles
): Promise<void> {
  await container.commands.exec(["sh", "-c", "kill -9 -1 2>/dev/null; true"], {
    user: AUTHORING_GUEST_USER,
  });
}

export async function giveWorkspaceToAuthor(
  container: GuestFiles
): Promise<void> {
  const given = await container.commands.exec([
    "chown",
    "-R",
    `${AUTHORING_GUEST_USER}:${AUTHORING_GUEST_USER}`,
    MODULE_SANDBOX_ROOT,
  ]);
  if (given.exitCode !== 0) {
    throw new Error("The sandbox workspace could not be prepared");
  }
}
