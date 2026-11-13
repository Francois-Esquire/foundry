import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Bun loads `.env` files from the working directory on its own. Marbles
 * loads a workspace's environment itself, after it has recorded the machine
 * environment, so every Marbles process starts with that loading off: the
 * installed `bin/marbles`, the package scripts, and every spawn below.
 */
export const RUNTIME_FLAGS = ["--no-env-file"] as const;

/** Marbles runs under Bun; so does the parent, except under a Node test runner. */
export function runtime(): string {
  return "Bun" in globalThis ? process.execPath : "bun";
}

/**
 * Why this process cannot record a machine environment: Bun was started
 * without `--no-env-file` (`bun dist/cli.js`, `bunx --bun`) and a `.env` file
 * it loads on its own is in the working directory. Undefined otherwise.
 */
export function envFilesLoaded(): string | undefined {
  if (!("Bun" in globalThis) || process.execArgv.includes("--no-env-file")) {
    return;
  }
  // Every mode Bun might pick, so a file it loads is never missed.
  const modes = new Set(["development", "production", "test"]);
  if (process.env.NODE_ENV) {
    modes.add(process.env.NODE_ENV);
  }
  const files = [
    ".env",
    ".env.local",
    ...[...modes].flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`]),
  ];
  const loaded = files.filter((file) => existsSync(join(process.cwd(), file)));
  if (loaded.length === 0) {
    return;
  }
  return `Bun loaded ${loaded.join(", ")} from ${process.cwd()} before Marbles could record the machine environment. Run the marbles command, or start Bun with --no-env-file.`;
}
