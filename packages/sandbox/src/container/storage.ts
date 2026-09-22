import { posix } from "node:path";

import type { EntryStats, Storage } from "@foundry/core/storage";

import type { SandboxExecResult } from "../types";

interface GuestFiles {
  list(
    path: string
  ): Promise<readonly { path: string; kind: string; mode: number }[]>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ kind: string; mode: number }>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** All paths and commands are guest-side; no host filesystem access. */
export function guestStorage(
  fs: GuestFiles,
  exec: (argv: string[]) => Promise<SandboxExecResult>
): Storage {
  const classify = (kind: string, mode: number): EntryStats => {
    if (kind === "file" || kind === "directory" || kind === "symlink") {
      return { type: kind };
    }
    // The SDK groups special entries as "other"; POSIX mode preserves their type.
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX file types occupy masked mode bits.
    switch (mode & 0o17_0000) {
      case 0o14_0000:
        return { type: "socket" };
      case 0o01_0000:
        return { type: "pipe" };
      case 0o06_0000:
      case 0o02_0000:
        return { type: "device" };
      default:
        return { type: "unknown" };
    }
  };
  const run = async (argv: string[]): Promise<string> => {
    const result = await exec(argv);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `${argv[0]} failed`);
    }
    return result.stdout;
  };
  const inspect: Storage["lstat"] = async (path) => {
    if (path === "/") {
      const stats = await fs.stat(path);
      return classify(stats.kind, stats.mode);
    }
    // The SDK's stat follows links. Directory entries describe the link itself.
    const entry = (await fs.list(posix.dirname(path))).find(
      (candidate) => posix.basename(candidate.path) === posix.basename(path)
    );
    if (!entry) {
      throw Object.assign(new Error(`No entry at ${path}`), { code: "ENOENT" });
    }
    return classify(entry.kind, entry.mode);
  };
  return {
    lstat: inspect,
    async readDirectory(path) {
      return (await fs.list(path)).map((entry) => ({
        name: posix.basename(entry.path),
        ...classify(entry.kind, entry.mode),
      }));
    },
    async readFile(path) {
      return new Uint8Array(await fs.read(path));
    },
    async readLink(path) {
      const result = await run(["readlink", "-z", "--", path]);
      if (!result.endsWith("\0")) {
        throw new Error("Guest readlink returned no target");
      }
      return result.slice(0, -1);
    },
    async realpath(path) {
      const result = await run(["readlink", "-ez", "--", path]);
      if (!result.endsWith("\0")) {
        throw new Error("Guest readlink returned no canonical path");
      }
      return result.slice(0, -1);
    },
    async replaceFile(path, bytes) {
      if ((await inspect(path)).type !== "file") {
        throw new Error(`Cannot replace a non-regular file: ${path}`);
      }
      const { mode } = await fs.stat(path);
      const temp = posix.join(
        posix.dirname(path),
        `.${posix.basename(path)}.${crypto.randomUUID()}.tmp`
      );
      try {
        await fs.write(temp, new Uint8Array(bytes));
        // biome-ignore lint/suspicious/noBitwiseOperators: Preserve POSIX permission bits without the file type.
        await run(["chmod", (mode & 0o7777).toString(8), "--", temp]);
        await fs.rename(temp, path);
      } catch (error) {
        await fs.remove(temp).catch(() => undefined);
        throw error;
      }
    },
    separator: "/",
    async writeFile(path, content) {
      await fs.mkdir(posix.dirname(path));
      await fs.write(
        path,
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : new Uint8Array(content)
      );
    },
  };
}
