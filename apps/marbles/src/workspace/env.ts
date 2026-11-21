import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { environmentSnapshot } from "~/lib/environment";

export interface WorkspaceEnvironment {
  readonly machine: Readonly<Record<string, string>>;
  readonly workspace: Readonly<Record<string, string>>;
}

export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
}

const SCHEMA = ".env.schema";
const INSTALL = "bun add -d varlock";
const VARLOCK_TIMEOUT_MS = 60_000;

function varlockAt(root: string): string | undefined {
  const local = join(root, "node_modules", ".bin", "varlock");
  if (existsSync(local)) {
    return local;
  }
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "varlock"))
    .find((candidate) => existsSync(candidate));
}

function run(
  varlock: string,
  root: string,
  timeout: number
): {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
} {
  const dir = mkdtempSync(join(tmpdir(), "marbles-varlock-"));
  try {
    const path = join(dir, "stdout");
    const out = openSync(path, "w", 0o600);
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(
        varlock,
        ["load", "--format", "json", "--path", root],
        {
          cwd: root,
          encoding: "utf8",
          env: process.env,
          killSignal: "SIGKILL",
          stdio: ["ignore", out, "pipe"],
          timeout,
        }
      );
    } finally {
      closeSync(out);
    }
    return {
      status: result.status,
      stderr: String(result.stderr ?? ""),
      stdout: readFileSync(path, "utf8"),
      timedOut:
        (result.error as NodeJS.ErrnoException | undefined)?.code ===
        "ETIMEDOUT",
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function parsed(stdout: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function load(
  root: string,
  timeout: number
): { readonly problem: string } | { readonly values: Record<string, string> } {
  const schema = join(root, SCHEMA);
  if (!existsSync(schema)) {
    return { values: {} };
  }
  const varlock = varlockAt(root);
  if (!varlock) {
    return {
      problem: `${schema} needs Varlock to load; install it with \`${INSTALL}\` in ${root}`,
    };
  }
  const { status, stderr, stdout, timedOut } = run(varlock, root, timeout);
  if (timedOut) {
    return {
      problem: `${schema} does not resolve: Varlock ran longer than ${String(timeout / 1000)}s and was stopped`,
    };
  }
  if (status !== 0) {
    const said = stripVTControlCharacters(`${stdout}${stderr}`).trim();
    return { problem: `${schema} does not resolve:\n${said}` };
  }
  const resolvedValues = parsed(stdout);
  if (resolvedValues === undefined) {
    return {
      problem: `${schema} does not resolve: Varlock printed something other than a JSON object`,
    };
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(resolvedValues)) {
    if (value !== undefined && value !== null) {
      values[name] = String(value);
    }
  }
  return { values };
}

export function loadEnvironment(
  root: string,
  mode: "require" | "warn",
  print: (line: string) => void,
  timeout: number = VARLOCK_TIMEOUT_MS
): WorkspaceEnvironment {
  const machine = environmentSnapshot();
  const loaded = load(root, timeout);
  if ("problem" in loaded) {
    if (mode === "require") {
      throw new EnvironmentError(loaded.problem);
    }
    print(`[env] ${loaded.problem}`);
    return { machine, workspace: {} };
  }
  return { machine, workspace: loaded.values };
}
