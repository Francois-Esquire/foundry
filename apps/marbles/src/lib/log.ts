import { inspect } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogOrigin =
  | { readonly kind: "step" }
  | {
      readonly kind: "setup";
      readonly runId: string;
      readonly workflow: string;
    };

export interface Log {
  debug(...values: readonly unknown[]): void;
  error(...values: readonly unknown[]): void;
  info(...values: readonly unknown[]): void;
  warn(...values: readonly unknown[]): void;
  (...values: readonly unknown[]): void;
}

const INSPECT_DEPTH = 6;

export function formatLogValues(values: readonly unknown[]): string {
  return values
    .map((value) =>
      typeof value === "string"
        ? value
        : inspect(value, { breakLength: 100, depth: INSPECT_DEPTH })
    )
    .join(" ");
}

export function createLog(
  write: (level: LogLevel, message: string) => void
): Log {
  const at =
    (level: LogLevel) =>
    (...values: readonly unknown[]) =>
      write(level, formatLogValues(values));
  return Object.assign(at("info"), {
    debug: at("debug"),
    error: at("error"),
    info: at("info"),
    warn: at("warn"),
  });
}
