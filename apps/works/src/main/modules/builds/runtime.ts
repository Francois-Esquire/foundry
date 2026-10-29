import { createHash } from "node:crypto";
import { withConfirmedModuleContainerCleanup } from "@foundry/modules/platform/container-cleanup";
import {
  type Container,
  createContainers,
} from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import type { SandboxProcessesFacet } from "@foundry/sandbox/types";
import type { BuildRuntime } from "./controller";
import { auditBuildWorkspace } from "./workspace";

const ROOT = "/workspace";
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

export async function createBuildRuntime(
  userData: string
): Promise<BuildRuntime> {
  const { createMicrosandboxRuntime } = await import(
    "@foundry/sandbox/container/microsandbox-runtime"
  );
  const runtime = createMicrosandboxRuntime();
  const containers = withConfirmedModuleContainerCleanup(
    createContainers({
      instanceLabel: createHash("sha256")
        .update(`${userData}/modules/build`)
        .digest("hex")
        .slice(0, 16),
      runtime,
      store: createMemoryContainerStore(),
    }),
    runtime
  );
  const cleanup = new Map<string, () => Promise<void>>();
  let prepared: Promise<void> | undefined;
  async function prepare() {
    prepared ??= (async () => {
      if (!(await runtime.isInstalled())) {
        throw new Error(
          "Module builds require the Microsandbox runtime. Install it before building."
        );
      }
      await containers.sweep();
    })().catch((error: unknown) => {
      prepared = undefined;
      throw error;
    });
    await prepared;
  }
  return {
    async run(source, signal, progress) {
      await prepare();
      signal.throwIfAborted();
      const container = await containers.start(
        {
          format: "foundry.sandbox.container/1",
          image: "docker.io/oven/bun:1-slim",
          mounts: [],
          network: "unrestricted",
          resources: {
            cpus: 1,
            memoryBytes: 2 * 1024 * 1024 * 1024,
            pids: 256,
          },
          workdir: ROOT,
        },
        signal
      );
      async function close() {
        await container.close();
        await containers.remove(container.id);
        cleanup.delete(container.id);
      }
      cleanup.set(container.id, close);
      try {
        await container.files.copyIn(
          Object.fromEntries(
            Object.entries(source).map(([path, text]) => [
              `${ROOT}/${path}`,
              text,
            ])
          )
        );
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
          signal.throwIfAborted();
          progress({ phase });
          const { exitCode, log } = await runBuildCommand(
            container.processes,
            argv,
            { cwd: ROOT, signal }
          );
          progress({ log, phase });
          if (exitCode !== 0) {
            throw new Error(`${phase} failed (exit ${exitCode}).\n${log}`);
          }
        }
        await auditBuildWorkspace(container.files, source, signal);
        const lock = decoder.decode(
          await container.files.readFile(`${ROOT}/bun.lock`)
        );
        const outputs = await collectOutputs(container, signal);
        signal.throwIfAborted();
        return { outputs, source: { ...source, "bun.lock": lock } };
      } finally {
        // Stop guest writers before the caller publishes their outputs.
        await close();
      }
    },
    async shutdown() {
      await Promise.all([...cleanup.values()].map((close) => close()));
      await containers.shutdown();
    },
  };
}

/** Runs one guest command and keeps the last 32 KiB characters of its output. */
export async function runBuildCommand(
  processes: Pick<SandboxProcessesFacet, "spawn">,
  argv: readonly string[],
  options: { readonly cwd: string; readonly signal: AbortSignal }
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
  const chunks: Uint8Array[] = [];
  let retained = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    retained += chunk.byteLength;
    // Whole chunks are dropped only while the rest still fills the tail.
    while (
      chunks.length > 1 &&
      retained - (chunks[0]?.byteLength ?? 0) >= RETAINED_OUTPUT_BYTES
    ) {
      retained -= chunks.shift()?.byteLength ?? 0;
    }
  }
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(-RETAINED_OUTPUT_BYTES));
}

async function collectOutputs(
  container: Container,
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
      `${ROOT}/${path}`
    )) {
      const file = `${path}/${entry.name}`;
      if (entry.type === "directory") {
        await visit(file, depth + 1);
      } else if (entry.type === "file") {
        count += 1;
        if (count > MAX_OUTPUT_FILES) {
          throw new Error("Build emitted too many files");
        }
        const value = await container.files.readFile(`${ROOT}/${file}`);
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
  for (const entry of await container.files.readDirectory(`${ROOT}/packages`)) {
    if (
      entry.type === "directory" &&
      (await container.files.isDirectory(`${ROOT}/packages/${entry.name}/dist`))
    ) {
      if (
        (await container.files.lstat(`${ROOT}/packages/${entry.name}/dist`))
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
