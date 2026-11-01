import { randomUUID } from "node:crypto";
import type { ModuleCapabilityCatalog } from "@foundry/modules/gateway/types";
import type { Container } from "@foundry/sandbox/container/containers";
import type { SandboxProcessesFacet } from "@foundry/sandbox/types";
import { worksCapabilityCatalog } from "../capabilities";
import type { ModuleSandboxes } from "../sandboxes/coordinator";
import type { BuildRuntime } from "./controller";
import { auditBuildWorkspace } from "./workspace";

/**
 * Where builds keep their scratch directories in the Module sandbox: beside
 * the authoring workspace, never inside it, so a Module may have its own
 * `builds/` folder. Only {@link BUILD_USER} may enter it: a chat turn shares
 * the sandbox but works as another user, so it can neither read a build in
 * flight nor change its outputs before they are collected.
 */
const MODULE_BUILDS_ROOT = "/builds";

/** Builds run as root, which the authoring guest user is not. */
const BUILD_USER = "root";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_FILES = 4096;
const LOG_CHARACTERS = 32_768;
/**
 * Command output is read as it streams and only its tail is held, so a command
 * that never stops writing cannot grow host memory. UTF-8 spends at most three
 * bytes per UTF-16 unit; the fourth leaves a sequence cut at the tail's start
 * well outside the log.
 */
const RETAINED_OUTPUT_BYTES = 4 * LOG_CHARACTERS;
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Builds borrow their Module's sandbox from the coordinator rather than
 * starting a VM, and work in a scratch directory of their own inside it, so
 * one build never sees another's files or what a chat turn left behind
 * ({@link MODULE_BUILDS_ROOT}).
 * The workspace's `generate` writes the Gateway client from `catalog`, the
 * host operations this Works provides, handed over beside the scratch
 * directory so it never becomes build input.
 */
export function createBuildRuntime(
  sandboxes: Pick<ModuleSandboxes, "borrow">,
  catalog: ModuleCapabilityCatalog = worksCapabilityCatalog()
): BuildRuntime {
  return {
    async run({ moduleId, progress, signal, source }) {
      const loan = await sandboxes.borrow(moduleId, {
        signal,
        waiting: () =>
          progress({
            log: "Waiting for a sandbox. Turn off another Module to free one.",
            phase: "preparing",
          }),
      });
      const { container } = loan;
      const lifetime = AbortSignal.any([signal, loan.signal]);
      const root = `${MODULE_BUILDS_ROOT}/${randomUUID()}`;
      const catalogPath = `${root}.catalog.json`;
      // The build's own temporary files, where a turn cannot plant any.
      const temporary = `${root}.tmp`;
      try {
        const scratch = await container.commands.exec(
          [
            "sh",
            "-c",
            'mkdir -p "$1" && chmod 0700 "$1" && mkdir -m 0700 "$2"',
            "scratch",
            MODULE_BUILDS_ROOT,
            temporary,
          ],
          { signal: lifetime, user: BUILD_USER }
        );
        if (scratch.exitCode !== 0) {
          throw new Error("The build directory could not be prepared");
        }
        await container.files.copyIn({
          ...Object.fromEntries(
            Object.entries(source).map(([path, text]) => [
              `${root}/${path}`,
              text,
            ])
          ),
          [catalogPath]: JSON.stringify(catalog),
        });
        const commands = [
          {
            argv: [
              "bun",
              "install",
              "--ignore-scripts",
              ...(source["bun.lock"] ? ["--frozen-lockfile"] : []),
            ],
            phase: "installing",
          },
          { argv: ["bun", "run", "generate"], phase: "generating" },
          { argv: ["bun", "run", "typecheck"], phase: "checking" },
          { argv: ["bun", "run", "build"], phase: "building" },
        ] as const;
        for (const { phase, argv } of commands) {
          lifetime.throwIfAborted();
          progress({ phase });
          const { exitCode, log } = await runBuildCommand(
            container.processes,
            argv,
            {
              cwd: root,
              environment: {
                FOUNDRY_MODULE_CATALOG_PATH: catalogPath,
                TMPDIR: temporary,
              },
              signal: lifetime,
              user: BUILD_USER,
            }
          );
          progress({ log, phase });
          if (exitCode !== 0) {
            throw new Error(`${phase} failed (exit ${exitCode}).\n${log}`);
          }
        }
        await auditBuildWorkspace(container.files, source, lifetime, root);
        const lock = decoder.decode(
          await container.files.readFile(`${root}/bun.lock`)
        );
        // Outputs are read into memory here, so nothing the guest does
        // afterwards can change what the caller publishes.
        const outputs = await collectOutputs(container, root, lifetime);
        lifetime.throwIfAborted();
        return { outputs, source: { ...source, "bun.lock": lock } };
      } finally {
        await container.commands
          .exec(["rm", "-rf", root, catalogPath, temporary], {
            user: BUILD_USER,
          })
          // A sandbox that is stopping takes the directory with it.
          .catch(() => undefined);
        loan.release();
      }
    },
  };
}

/** Runs one guest command and keeps the last 32 KiB characters of its output. */
export async function runBuildCommand(
  processes: Pick<SandboxProcessesFacet, "spawn">,
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly user?: string;
    readonly environment?: Readonly<Record<string, string>>;
  }
): Promise<{ readonly exitCode: number; readonly log: string }> {
  const child = await processes.spawn(argv, options);
  child.stdin.end();
  try {
    const [stdout, stderr] = await Promise.all([
      outputTail(child.stdout),
      outputTail(child.stderr),
    ]);
    const { exitCode } = await child.exited;
    const log = [stdout, stderr]
      .filter(Boolean)
      .join("\n")
      .slice(-LOG_CHARACTERS);
    return { exitCode, log };
  } catch (error) {
    options.signal.throwIfAborted();
    throw error;
  }
}

async function outputTail(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let chunks: Uint8Array[] = [];
  let head = 0;
  let retained = 0;
  for await (const received of stream) {
    // A chunk longer than the tail is cut to its end at once, so it is never
    // held whole.
    const chunk =
      received.byteLength > RETAINED_OUTPUT_BYTES
        ? received.slice(-RETAINED_OUTPUT_BYTES)
        : received;
    chunks.push(chunk);
    retained += chunk.byteLength;
    // Whole chunks are dropped only while the rest still fills the tail.
    while (
      chunks.length - head > 1 &&
      retained - (chunks[head]?.byteLength ?? 0) >= RETAINED_OUTPUT_BYTES
    ) {
      retained -= chunks[head]?.byteLength ?? 0;
      head += 1;
    }
    if (head > chunks.length / 2) {
      chunks = chunks.slice(head);
      head = 0;
    }
  }
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks.slice(head)) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(-RETAINED_OUTPUT_BYTES));
}

async function collectOutputs(
  container: Container,
  root: string,
  signal: AbortSignal
): Promise<Record<string, Uint8Array>> {
  const outputs: Record<string, Uint8Array> = {};
  let bytes = 0;
  let count = 0;
  async function visit(path: string, depth = 0) {
    if (depth > 32) {
      throw new Error("Build outputs have too many nested directories");
    }
    signal.throwIfAborted();
    for (const entry of await container.files.readDirectory(
      `${root}/${path}`
    )) {
      const file = `${path}/${entry.name}`;
      if (entry.type === "directory") {
        await visit(file, depth + 1);
      } else if (entry.type === "file") {
        count += 1;
        if (count > MAX_OUTPUT_FILES) {
          throw new Error("Build emitted too many files");
        }
        const value = await container.files.readFile(`${root}/${file}`);
        bytes += value.byteLength;
        if (bytes > MAX_OUTPUT_BYTES) {
          throw new Error("Build outputs exceed 64 MiB");
        }
        outputs[file] = value;
      } else {
        throw new Error(`Build output must be a regular file: ${file}`);
      }
    }
  }
  for (const entry of await container.files.readDirectory(`${root}/packages`)) {
    if (
      entry.type === "directory" &&
      (await container.files.isDirectory(`${root}/packages/${entry.name}/dist`))
    ) {
      if (
        (await container.files.lstat(`${root}/packages/${entry.name}/dist`))
          .type !== "directory"
      ) {
        throw new Error("Build dist must be a directory");
      }
      await visit(`packages/${entry.name}/dist`);
    }
  }
  if (!count) {
    throw new Error("Build emitted no package dist files");
  }
  return outputs;
}
