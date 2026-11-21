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

function matching(
  files: Map<string, Uint8Array> | undefined,
  targets: string[]
) {
  const named = targets.filter((target) => !target.startsWith("-"));
  return [...(files?.keys() ?? [])].filter((path) =>
    named.some((target) => path === target || path.startsWith(`${target}/`))
  );
}

function isGuestDirectory(
  files: Map<string, Uint8Array> | undefined,
  path: string
): boolean {
  return (
    path === MODULE_SANDBOX_ROOT ||
    [...(files?.keys() ?? [])].some((file) => file.startsWith(`${path}/`))
  );
}

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

function guestRead(
  files: Map<string, Uint8Array> | undefined,
  command: readonly string[]
): { exitCode: number; stdout: string } | undefined {
  const [program, ...args] = command;
  const target = args.at(-1) ?? "";
  const answer = (found: boolean, stdout = "") =>
    found ? { exitCode: 0, stdout } : { exitCode: 1, stdout: "" };
  if (program === "sh" && args[2] === "collect-source") {
    const bytes = files?.get(target);
    return answer(
      bytes !== undefined,
      Buffer.from(bytes?.slice(0, Number(args[3])) ?? []).toString("base64")
    );
  }
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
    const [, , , staged = "", target = ""] = args;
    const bytes = files?.get(staged);
    if (bytes) {
      files?.set(target, bytes);
    }
    return 0;
  }
  if (args.includes("check-absent")) {
    return matching(files, [args.at(-1) ?? ""]).length > 0 ? 0 : 1;
  }
  if (args[0] === "install") {
    files?.set(`${cwd}/bun.lock`, encoder.encode("{}"));
  } else if (args[1] === "build") {
    files?.set(
      `${cwd}/packages/app/dist/index.html`,
      encoder.encode("<h1>Built</h1>")
    );
    files?.set(
      `${cwd}/packages/server/dist/index.js`,
      encoder.encode("export {};")
    );
  }
  return 0;
}

export function fakeContainerRuntime() {
  const executions: {
    catalog?: string;
    command: string[];
    env: Record<string, string>;
    user?: string;
  }[] = [];
  const execute: FakeExecHandler = (command, options) => {
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
