import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// V12.5 canonical equivalence. Two datasets are equivalent when every
// artifact matches after the documented volatile fields are removed. Nothing
// architectural is dropped: the list below is timing and provenance only.

/**
 * Volatile fields per artifact, as JSON-pointer-like paths from the artifact
 * root. `*` matches any key or index. Anything not listed here is canonical.
 */
const SEMANTICS_VOLATILE_FIELDS: Record<string, readonly string[]> = {
  /** Wall clock, timings, and cache provenance of the temporal dataset. */
  "history-manifest.json": [
    "generatedAt",
    "generation",
    "snapshots.*.durationMs",
    "snapshots.*.cached",
  ],
  /** Wall clock and per-run timings of the current dataset. */
  "manifest.json": ["generatedAt", "generation"],
  /** The V8 simulation clock inside every package report. */
  "packages/*.json": [
    "recenteringCandidates.impacts.summary.runtimeMs",
    "recenteringCandidates.reviews.summary.runtimeMs",
  ],
};

/**
 * String lists that are sets: their order followed the type checker's
 * property-resolution history before V12.6 and is sorted since, so a
 * comparison across that boundary sorts both sides. Same path syntax as
 * `SEMANTICS_VOLATILE_FIELDS`.
 */
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
  /** Dot path inside the artifact; empty when the file is missing on one side. */
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

/**
 * The artifact without its volatile fields. `file` is the dataset-relative
 * path; pass `kind` to canonicalize a history manifest, whose file name
 * (`manifest.json`) collides with the current dataset's.
 */
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

/** Object keys in sorted order at every depth; key order is serialization, not semantics. */
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
  /** Canonicalization kind override per file (history manifests). */
  kindOf?: (file: string) => string | undefined;
  /** Stop after this many differences; the result is still `equivalent: false`. */
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

/** Every JSON artifact under a dataset, relative posix paths, sorted. */
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

/** Canonical comparison of two materialized datasets, artifact by artifact. */
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

/** Canonical content of one artifact as JSON; equal strings mean equivalent artifacts. */
export function canonicalSemanticsText(
  file: string,
  value: unknown,
  kind?: string
): string {
  return JSON.stringify(canonicalizeSemanticsArtifact(file, value, kind));
}
