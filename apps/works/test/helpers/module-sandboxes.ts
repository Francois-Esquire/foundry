import { ProcessController } from "@foundry/sandbox/process-controller";
import type { FakeExecHandler } from "@foundry/sandbox/testing";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { SandboxCapacity } from "~/main/modules/sandboxes/capacity";
import {
  MODULE_SANDBOX_ROOT,
  ModuleSandboxes,
  type ModuleSandboxesOptions,
} from "~/main/modules/sandboxes/coordinator";

const encoder = new TextEncoder();

/** Guest files at or under any of `targets`; flags are not targets. */
function matching(
  files: Map<string, Uint8Array> | undefined,
  targets: string[]
) {
  const named = targets.filter((target) => !target.startsWith("-"));
  return [...(files?.keys() ?? [])].filter((path) =>
    named.some((target) => path === target || path.startsWith(`${target}/`))
  );
}

/** Directories are implied by the files under them. */
function isGuestDirectory(
  files: Map<string, Uint8Array> | undefined,
  path: string
): boolean {
  return (
    path === MODULE_SANDBOX_ROOT ||
    [...(files?.keys() ?? [])].some((file) => file.startsWith(`${path}/`))
  );
}

/** The entries `find -P <root> -mindepth 1 [-maxdepth 1]` prints. */
function guestEntries(
  files: Map<string, Uint8Array> | undefined,
  root: string,
  recursive: boolean
): string {
  const entries = new Map<string, "d" | "f">();
  for (const file of files?.keys() ?? []) {
    if (!file.startsWith(`${root}/`)) {
      continue;
    }
    const segments = file.slice(root.length + 1).split("/");
    const depth = recursive ? segments.length : 1;
    for (let index = 0; index < depth; index += 1) {
      entries.set(
        [root, ...segments.slice(0, index + 1)].join("/"),
        index === segments.length - 1 ? "f" : "d"
      );
    }
  }
  return [...entries].map(([path, type]) => `${type} ${path}\0`).join("");
}

/**
 * An authoring agent's reads, which run as its user: answered from the
 * guest's files. Undefined for any other command.
 */
function guestRead(
  files: Map<string, Uint8Array> | undefined,
  command: readonly string[]
): { exitCode: number; stdout: string } | undefined {
  const [program, ...args] = command;
  const target = args.at(-1) ?? "";
  const answer = (found: boolean, stdout = "") =>
    found ? { exitCode: 0, stdout } : { exitCode: 1, stdout: "" };
  switch (program) {
    case "base64": {
      const bytes = files?.get(target);
      return answer(
        bytes !== undefined,
        Buffer.from(bytes ?? []).toString("base64")
      );
    }
    case "realpath":
      return answer(
        files?.has(target) === true || isGuestDirectory(files, target),
        `${target}\n`
      );
    case "test":
      return answer(isGuestDirectory(files, target));
    case "find":
      return answer(
        true,
        guestEntries(files, args[1] ?? "", !args.includes("-maxdepth"))
      );
    default:
      return;
  }
}

/** What the fake guest does for one command; its exit code. */
function guestCommand(
  files: Map<string, Uint8Array> | undefined,
  command: readonly string[],
  cwd: string
): number {
  const [program, ...args] = command;
  if (program === "rm") {
    for (const path of matching(files, args)) {
      files?.delete(path);
    }
    return 0;
  }
  if (args[2] === "write") {
    // An authoring agent's staged write, copied into place as its user.
    const [, , , staged = "", target = ""] = args;
    const bytes = files?.get(staged);
    if (bytes) {
      files?.set(target, bytes);
    }
    return 0;
  }
  if (args.includes("check-absent")) {
    // The coding tools' absence probe: exit 1 when nothing is there.
    return matching(files, [args.at(-1) ?? ""]).length > 0 ? 0 : 1;
  }
  if (args[0] === "install") {
    files?.set(`${cwd}/bun.lock`, encoder.encode("{}"));
  } else if (args[1] === "build") {
    files?.set(
      `${cwd}/packages/app/dist/index.html`,
      encoder.encode("<h1>Built</h1>")
    );
    // The starter Manifest's Program entry.
    files?.set(
      `${cwd}/packages/server/dist/index.js`,
      encoder.encode("export {};")
    );
  }
  return 0;
}

/**
 * The in-memory container runtime with a guest that acts like a passing
 * build, writing a lockfile on install and the app and server dist files on
 * build in the command's directory; `rm -rf` removes what it names, an
 * authoring agent's staged write is copied into place, and the coding
 * tools' absence probe and the agent's reads answer from the guest's files.
 */
export function fakeContainerRuntime() {
  /** Each command's environment and user, and the Gateway catalog it was handed. */
  const executions: {
    catalog?: string;
    command: string[];
    env: Record<string, string>;
    user?: string;
  }[] = [];
  const execute: FakeExecHandler = (command, options) => {
    // One guest per test that builds; every instance shares the handler.
    const files = runtime.instances.at(-1)?.files;
    const catalogPath = options.env.FOUNDRY_MODULE_CATALOG_PATH;
    const catalog = catalogPath ? files?.get(catalogPath) : undefined;
    executions.push({
      command,
      env: options.env,
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(catalog ? { catalog: new TextDecoder().decode(catalog) } : {}),
    });
    return {
      stderr: "",
      ...(guestRead(files, command) ?? {
        exitCode: guestCommand(files, command, options.cwd),
        stdout: "",
      }),
    };
  };
  const runtime = createFakeContainerRuntime({
    exec: execute,
    async spawn(command, options) {
      const result = await execute(command, options);
      const child = new ProcessController(() => Promise.resolve());
      child.stdout.write(result.stdout);
      child.stderr.write(result.stderr);
      child.complete(result.exitCode);
      return child;
    },
  });
  return { executions, runtime };
}

/**
 * The Works coordinator over {@link fakeContainerRuntime}: real registry,
 * real confirmed cleanup, no VM.
 */
export function fakeModuleSandboxes(
  limits: { memoryBytes: number; sandboxes: number } = {
    memoryBytes: 8 * 1024 ** 3,
    sandboxes: 4,
  },
  coordinator: Pick<ModuleSandboxesOptions, "admit" | "resources"> = {}
) {
  const { executions, runtime } = fakeContainerRuntime();
  const capacity = new SandboxCapacity(limits);
  const sandboxes = new ModuleSandboxes({
    capacity,
    instance: "/tmp/works-test",
    runtime: () => Promise.resolve(runtime),
    ...coordinator,
  });
  return { capacity, executions, runtime, sandboxes };
}
