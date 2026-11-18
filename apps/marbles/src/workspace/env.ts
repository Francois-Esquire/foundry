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
  root: string
): {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
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
          stdio: ["ignore", out, "pipe"],
        }
      );
    } finally {
      closeSync(out);
    }
    return {
      status: result.status,
      stderr: String(result.stderr ?? ""),
      stdout: readFileSync(path, "utf8"),
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function load(
  root: string
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
  const { status, stderr, stdout } = run(varlock, root);
  if (status !== 0) {
    const said = stripVTControlCharacters(`${stdout}${stderr}`).trim();
    return { problem: `${schema} does not resolve:\n${said}` };
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    JSON.parse(stdout) as Record<string, unknown>
  )) {
    if (value !== undefined && value !== null) {
      values[name] = String(value);
    }
  }
  return { values };
}

export function loadEnvironment(
  root: string,
  mode: "require" | "warn",
  print: (line: string) => void
): WorkspaceEnvironment {
  const machine = environmentSnapshot();
  const loaded = load(root);
  if ("problem" in loaded) {
    if (mode === "require") {
      throw new EnvironmentError(loaded.problem);
    }
    print(`[env] ${loaded.problem}`);
    return { machine, workspace: {} };
  }
  return { machine, workspace: loaded.values };
}
