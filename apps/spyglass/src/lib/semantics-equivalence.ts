import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATASET_FILES,
  HISTORY_DIRECTORY,
  HISTORY_FILES,
} from "./dataset-layout";

const HISTORY_MANIFEST_VOLATILE_FIELDS = [
  "generatedAt",
  "generation",
  "snapshots.*.durationMs",
  "snapshots.*.cached",
] as const;

const SEMANTICS_VOLATILE_FIELDS: Record<string, readonly string[]> = {
  "history-manifest.json": HISTORY_MANIFEST_VOLATILE_FIELDS,
  [`${HISTORY_DIRECTORY}/${HISTORY_FILES.manifest}`]:
    HISTORY_MANIFEST_VOLATILE_FIELDS,
  [DATASET_FILES.manifest]: ["generatedAt", "generation"],
  "packages/*.json": [
    "recenteringCandidates.impacts.summary.runtimeMs",
    "recenteringCandidates.reviews.summary.runtimeMs",
  ],
};

const SEMANTICS_UNORDERED_FIELDS: Record<string, readonly string[]> = {
  "packages/*.json": [
    "conceptOverlap.candidates.*.structure.shared",
    "conceptOverlap.candidates.*.structure.baseShared",
    "conceptOverlap.candidates.*.structure.compatibleShared",
    "conceptOverlap.candidates.*.structure.leftOnly",
    "conceptOverlap.candidates.*.structure.rightOnly",
  ],
};

interface SemanticsDifference {
  file: string;
  kind: "missing-left" | "missing-right" | "value";
  left?: unknown;
  path: string;
  right?: unknown;
}

export interface SemanticsEquivalenceResult {
  comparedArtifacts: number;
  differences: SemanticsDifference[];
  equivalent: boolean;
}

function matchesPattern(file: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return file === pattern;
  }
  const [prefix, suffix] = pattern.split("*");
  return (
    file.startsWith(prefix ?? "") &&
    file.endsWith(suffix ?? "") &&
    !file
      .slice((prefix ?? "").length, file.length - (suffix ?? "").length)
      .includes("/")
  );
}

function fieldsFor(
  table: Record<string, readonly string[]>,
  file: string,
  kind?: string
): readonly string[] {
  const key = kind ?? file;
  return Object.entries(table)
    .filter(([pattern]) => matchesPattern(key, pattern))
    .flatMap(([, fields]) => fields);
}

function volatileFieldsFor(
  file: string,
  kind?: string | undefined
): readonly string[] {
  return fieldsFor(SEMANTICS_VOLATILE_FIELDS, file, kind);
}

function sortPath(value: unknown, segments: string[]): unknown {
  const [head, ...rest] = segments;
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (head === undefined) {
    return Array.isArray(value) &&
      value.every((item): item is string => typeof item === "string")
      ? [...value].sort((a, b) => a.localeCompare(b))
      : value;
  }
  if (Array.isArray(value)) {
    return head === "*" ? value.map((item) => sortPath(item, rest)) : value;
  }
  const record = value as Record<string, unknown>;
  if (head === "*") {
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, sortPath(item, rest)])
    );
  }
  if (!(head in record)) {
    return value;
  }
  return { ...record, [head]: sortPath(record[head], rest) };
}

function removePath(value: unknown, segments: string[]): unknown {
  const [head, ...rest] = segments;
  if (head === undefined || typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (head !== "*") {
      return value;
    }
    return value.map((item) => removePath(item, rest));
  }
  const record = value as Record<string, unknown>;
  if (head === "*") {
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, removePath(item, rest)])
    );
  }
  if (!(head in record)) {
    return value;
  }
  if (rest.length === 0) {
    const { [head]: _dropped, ...kept } = record;
    return kept;
  }
  return { ...record, [head]: removePath(record[head], rest) };
}

export function canonicalizeSemanticsArtifact(
  file: string,
  value: unknown,
  kind?: string
): unknown {
  let result = value;
  for (const field of volatileFieldsFor(file, kind)) {
    result = removePath(result, field.split("."));
  }
  for (const field of fieldsFor(SEMANTICS_UNORDERED_FIELDS, file, kind)) {
    result = sortPath(result, field.split("."));
  }
  return sortKeys(result);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])])
  );
}

function collectDifferences(
  file: string,
  left: unknown,
  right: unknown,
  at: string,
  out: SemanticsDifference[],
  limit: number
): void {
  if (out.length >= limit) {
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      out.push({
        file,
        kind: "value",
        left: left.length,
        path: `${at}.length`,
        right: right.length,
      });
      return;
    }
    left.forEach((item, index) => {
      collectDifferences(
        file,
        item,
        right[index],
        `${at}[${index}]`,
        out,
        limit
      );
    });
    return;
  }
  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    for (const key of [
      ...new Set([...Object.keys(a), ...Object.keys(b)]),
    ].sort()) {
      const next = at === "" ? key : `${at}.${key}`;
      collectDifferencesEntries(key, a, out, file, next, b, limit);
      if (out.length >= limit) {
        return;
      }
    }
    return;
  }
  if (left !== right) {
    out.push({ file, kind: "value", left, path: at, right });
  }
}

export interface CompareSemanticsOptions {
  kindOf?: (file: string) => string | undefined;
  limit?: number;
}

function collectDifferencesEntries(
  key: string,
  a: Record<string, unknown>,
  out: SemanticsDifference[],
  file: string,
  next: string,
  b: Record<string, unknown>,
  limit: number
) {
  if (!(key in a)) {
    out.push({ file, kind: "missing-left", path: next, right: b[key] });
  } else if (key in b) {
    collectDifferences(file, a[key], b[key], next, out, limit);
  } else {
    out.push({ file, kind: "missing-right", left: a[key], path: next });
  }
}

export function listSemanticsFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listSemanticsFiles(join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".json")) {
      files.push(rel);
    }
  }
  return files.sort();
}

export function compareSemanticsDatasets(
  left: string,
  right: string,
  options: CompareSemanticsOptions = {}
): SemanticsEquivalenceResult {
  const limit = options.limit ?? 50;
  const files = [
    ...new Set([...listSemanticsFiles(left), ...listSemanticsFiles(right)]),
  ].sort();
  const differences: SemanticsDifference[] = [];
  for (const file of files) {
    if (differences.length >= limit) {
      break;
    }
    const a = join(left, file);
    const b = join(right, file);
    if (!existsSync(a)) {
      differences.push({ file, kind: "missing-left", path: "" });
      continue;
    }
    if (!existsSync(b)) {
      differences.push({ file, kind: "missing-right", path: "" });
      continue;
    }
    const kind = options.kindOf?.(file);
    collectDifferences(
      file,
      canonicalizeSemanticsArtifact(
        file,
        JSON.parse(readFileSync(a, "utf8")),
        kind
      ),
      canonicalizeSemanticsArtifact(
        file,
        JSON.parse(readFileSync(b, "utf8")),
        kind
      ),
      "",
      differences,
      limit
    );
  }
  return {
    comparedArtifacts: files.length,
    differences,
    equivalent: differences.length === 0,
  };
}

export function canonicalSemanticsText(
  file: string,
  value: unknown,
  kind?: string
): string {
  return JSON.stringify(canonicalizeSemanticsArtifact(file, value, kind));
}
