import { createHash } from "node:crypto";
import { withConfirmedModuleContainerCleanup } from "@foundry/modules/platform/container-cleanup";
import {
  type Container,
  createContainers,
} from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import type { BuildRuntime } from "./controller";
import { auditBuildWorkspace } from "./workspace";

const ROOT = "/workspace";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_FILES = 4096;
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
          const result = await container.commands.exec(argv, {
            cwd: ROOT,
            signal,
          });
          const log = [result.stdout, result.stderr]
            .filter(Boolean)
            .join("\n")
            .slice(-32_768);
          progress({ log, phase });
          if (result.exitCode !== 0) {
            throw new Error(
              `${phase} failed (exit ${result.exitCode}).\n${log}`
            );
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
