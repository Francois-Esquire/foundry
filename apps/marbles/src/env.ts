import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { UsageError } from "~/args";

/**
 * A workspace's environment, loaded through Varlock before any module is
 * imported, so `roll`, `list`, and the dashboard see the same values.
 * A `.env.schema` at the workspace root opts in; without one
 * nothing changes. Values already in the environment win, and nothing is
 * written anywhere: a secret is resolved each time a process starts.
 */

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

/** Why the schema did not resolve, or undefined once its values are in `process.env`. */
function load(root: string): string | undefined {
  const schema = join(root, SCHEMA);
  if (!existsSync(schema)) {
    return;
  }
  const varlock = varlockAt(root);
  if (!varlock) {
    return `${schema} needs Varlock to load; install it with \`${INSTALL}\` in ${root}`;
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
    return `${schema} does not resolve:\n${said}`;
  }
  const values = JSON.parse(result.stdout) as Record<string, unknown>;
  for (const [name, value] of Object.entries(values)) {
    if (
      process.env[name] === undefined &&
      value !== undefined &&
      value !== null
    ) {
      process.env[name] = String(value);
    }
  }
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
): void {
  const problem = load(root);
  if (problem === undefined) {
    return;
  }
  if (mode === "require") {
    throw new UsageError(problem);
  }
  print(`[env] ${problem}`);
}
