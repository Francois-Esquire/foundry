import { randomUUID } from "node:crypto";
import type { ModuleCapabilityCatalog } from "@foundry/modules/gateway/types";
import type { Container } from "@foundry/sandbox/container/containers";
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
          const result = await container.commands.exec(argv, {
            cwd: root,
            // Turbo passes it through (globalEnv); `build` regenerates too.
            environment: {
              FOUNDRY_MODULE_CATALOG_PATH: catalogPath,
              TMPDIR: temporary,
            },
            signal: lifetime,
            user: BUILD_USER,
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
