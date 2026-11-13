import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { environmentSnapshot } from "~/lib/environment";

/**
 * A workspace's environment, loaded through Varlock before any module is
 * imported, so `roll`, `list`, and the dashboard see the same values.
 * A `.env.schema` at the workspace root opts in; without one
 * nothing changes. Values already in the environment win, and nothing is
 * written anywhere: a secret is resolved each time a process starts.
 */

/**
 * The environment this process had before the workspace's values merged, and
 * the values the workspace's schema resolved.
 */
export interface WorkspaceEnvironment {
  readonly machine: Readonly<Record<string, string>>;
  readonly workspace: Readonly<Record<string, string>>;
}

/** A workspace `.env.schema` that did not resolve when it had to. */
export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
}

const SCHEMA = ".env.schema";
const INSTALL = "bun add -d varlock";

/** The workspace's own `varlock`, else one on `PATH`. */
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

/** What the schema resolved, or why it did not. */
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
  const result = spawnSync(
    varlock,
    ["load", "--format", "json", "--path", root],
    { cwd: root, encoding: "utf8", env: process.env }
  );
  if (result.status !== 0) {
    const said = stripVTControlCharacters(
      `${result.stdout ?? ""}${result.stderr ?? ""}`
    ).trim();
    return { problem: `${schema} does not resolve:\n${said}` };
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    JSON.parse(result.stdout) as Record<string, unknown>
  )) {
    if (value !== undefined && value !== null) {
      values[name] = String(value);
    }
  }
  return { values };
}

/**
 * Load the workspace's environment. `require` fails with what is missing,
 * for `roll`; `warn` prints it and goes on, for the dashboard, headless
 * `run`, and listings, where only the work that reads a missing value fails.
 */
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
  for (const [name, value] of Object.entries(loaded.values)) {
    process.env[name] ??= value;
  }
  return { machine, workspace: loaded.values };
}
