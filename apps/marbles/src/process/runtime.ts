import { existsSync } from "node:fs";
import { join } from "node:path";

export const RUNTIME_FLAGS = ["--no-env-file"] as const;

export function runtime(): string {
  return "Bun" in globalThis ? process.execPath : "bun";
}

export function envFilesLoaded(): string | undefined {
  if (!("Bun" in globalThis) || process.execArgv.includes("--no-env-file")) {
    return;
  }
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
