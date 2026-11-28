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

function formatValue(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "boolean":
    case "number":
      return String(value);
    case "bigint":
      return `${String(value)}n`;
    case "symbol":
      return String(value);
    case "string":
      return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    case "function":
      return `[Function: ${value.name || "anonymous"}]`;
    case "object":
      return formatObject(value, depth, seen);
    default:
      return String(value);
  }
}

function formatObject(value: object, depth: number, seen: Set<object>): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof RegExp) {
    return String(value);
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (depth >= INSPECT_DEPTH) {
    return Array.isArray(value) ? "[Array]" : "[Object]";
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => formatValue(item, depth + 1, seen));
      return `[ ${items.join(", ")} ]`;
    }
    if (value instanceof Set) {
      const items = [...value].map((item) =>
        formatValue(item, depth + 1, seen)
      );
      return `Set(${String(value.size)}) { ${items.join(", ")} }`;
    }
    if (value instanceof Map) {
      const entries = [...value].map(
        ([key, entry]) =>
          `${formatValue(key, depth + 1, seen)} => ${formatValue(entry, depth + 1, seen)}`
      );
      return `Map(${String(value.size)}) { ${entries.join(", ")} }`;
    }
    const entries = Object.entries(value).map(
      ([key, entry]) => `${key}: ${formatValue(entry, depth + 1, seen)}`
    );
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  } finally {
    seen.delete(value);
  }
}

export function formatLogValues(values: readonly unknown[]): string {
  return values
    .map((value) =>
      typeof value === "string" ? value : formatValue(value, 0, new Set())
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
