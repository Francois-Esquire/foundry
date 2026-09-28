import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import type { PackageLocalReport } from "./package-local-types";
import { PACKAGE_LOCAL_REPORT_SCHEMA_VERSION } from "./package-local-types";
import { encodePackageFile } from "./semantics";
import { SEMANTIC_STAGE_VERSIONS } from "./semantics-stages";
import type { SurfaceReport } from "./types";

const listCachedPackagesPattern = /__/g;

// Package cache under `.foundry/cache/semantics/`. Disposable reuse
// material, never truth: an entry is used only when its kind, identity,
// fingerprint, and schema all match, and anything unreadable counts as a
// miss. Since V12.6 (schema 2) there are two entries per package:
//
//   packages/<id>.local.json   PackageLocalReport, keyed by the package's
//                              own sources and manifest
//   packages/<id>.json         assembled SurfaceReport, keyed by the whole
//                              workspace (its derived half reads everything)
//
// Every entry lands with its own rename, so a build that dies part-way
// keeps what it finished. Schema-1 entries stored full reports under the
// bare name and are rejected by the schema check, never read as local.

export const SEMANTICS_CACHE_SCHEMA_VERSION = 2;
export const DEFAULT_SEMANTICS_CACHE = ".foundry/cache/semantics";

export type CacheEntryKind = "package-local" | "package-report";

export interface CachedPackageMeta {
  /** Informational only; never part of validation. */
  analyzedAt: string;
  cacheSchemaVersion: number;
  /** Named fingerprint components; the shape depends on `kind`. */
  components: Record<string, string>;
  file: string;
  fingerprint: string;
  kind: CacheEntryKind;
  packageId: string;
  path: string;
  /** Schema of the cached payload: local report or `SurfaceReport`. */
  reportSchemaVersion: number;
}

export interface WorkspaceInputsMeta {
  cacheSchemaVersion: number;
  /** Root-relative path → content sha1 of the last build's workspace inputs. */
  files: Record<string, string>;
}

type CacheMissReason =
  | "cache-missing"
  | "cache-corrupt"
  | "cache-schema-changed"
  | "fingerprint-changed";

export type CacheLookup<T> =
  | { hit: true; meta: CachedPackageMeta; value: T }
  | { hit: false; reason: CacheMissReason; meta?: CachedPackageMeta };

function packageFiles(
  dir: string,
  id: string,
  kind: CacheEntryKind
): { payload: string; meta: string } {
  const encoded = encodePackageFile(id);
  const suffix = kind === "package-local" ? ".local" : "";
  return {
    meta: join(dir, "packages", `${encoded}${suffix}.meta.json`),
    payload: join(dir, "packages", `${encoded}${suffix}.json`),
  };
}

function schemaFor(kind: CacheEntryKind): number {
  return kind === "package-local"
    ? PACKAGE_LOCAL_REPORT_SCHEMA_VERSION
    : SEMANTIC_STAGE_VERSIONS.packageAnalysis.schemaVersion;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Whole file or nothing: written beside the target, then renamed over it. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMeta(value: unknown): value is CachedPackageMeta {
  return (
    isRecord(value) &&
    typeof value.cacheSchemaVersion === "number" &&
    (value.kind === "package-local" || value.kind === "package-report") &&
    typeof value.packageId === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.reportSchemaVersion === "number" &&
    isRecord(value.components)
  );
}

function isPayload(kind: CacheEntryKind, value: unknown): boolean {
  if (!isRecord(value) || typeof value.schemaVersion !== "number") {
    return false;
  }
  return kind === "package-local"
    ? isRecord(value.package) && Array.isArray(value.symbols)
    : isRecord(value.target);
}

export function lookupPackage<T>(
  dir: string,
  id: string,
  kind: CacheEntryKind,
  fingerprint: string
): CacheLookup<T> {
  const files = packageFiles(dir, id, kind);
  if (!existsSync(files.meta)) {
    return { hit: false, reason: "cache-missing" };
  }
  let meta: CachedPackageMeta;
  try {
    const parsed = readJson(files.meta);
    if (!isMeta(parsed)) {
      return { hit: false, reason: "cache-corrupt" };
    }
    meta = parsed;
  } catch {
    return { hit: false, reason: "cache-corrupt" };
  }
  if (
    meta.cacheSchemaVersion !== SEMANTICS_CACHE_SCHEMA_VERSION ||
    meta.kind !== kind ||
    meta.reportSchemaVersion !== schemaFor(kind)
  ) {
    return { hit: false, meta, reason: "cache-schema-changed" };
  }
  if (meta.packageId !== id || meta.fingerprint !== fingerprint) {
    return { hit: false, meta, reason: "fingerprint-changed" };
  }
  if (!existsSync(files.payload)) {
    return { hit: false, meta, reason: "cache-missing" };
  }
  try {
    const value = readJson(files.payload);
    if (
      !isPayload(kind, value) ||
      (value as { schemaVersion: number }).schemaVersion !==
        meta.reportSchemaVersion
    ) {
      return { hit: false, meta, reason: "cache-corrupt" };
    }
    return { hit: true, meta, value: value as T };
  } catch {
    return { hit: false, meta, reason: "cache-corrupt" };
  }
}

/** The cached payload regardless of fingerprint, for canonical comparison after a fresh computation. */
export function readCachedPackage(
  dir: string,
  id: string,
  kind: "package-local"
): PackageLocalReport | undefined;
export function readCachedPackage(
  dir: string,
  id: string,
  kind: "package-report"
): SurfaceReport | undefined;
export function readCachedPackage(
  dir: string,
  id: string,
  kind: CacheEntryKind
): PackageLocalReport | SurfaceReport | undefined {
  const files = packageFiles(dir, id, kind);
  if (!existsSync(files.payload)) {
    return undefined;
  }
  try {
    const value = readJson(files.payload);
    return isPayload(kind, value)
      ? (value as PackageLocalReport | SurfaceReport)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Entry counts and bytes under the cache, for the build report. */
export function cacheStatistics(dir: string): {
  packageEntries: number;
  localEntries: number;
  bytes: number;
  localBytes: number;
} {
  const packages = join(dir, "packages");
  const stats = { bytes: 0, localBytes: 0, localEntries: 0, packageEntries: 0 };
  if (!existsSync(packages)) {
    return stats;
  }
  for (const file of readdirSync(packages)) {
    const { size } = statSync(join(packages, file));
    stats.bytes += size;
    const local = file.includes(".local.");
    if (local) {
      stats.localBytes += size;
    }
    if (file.endsWith(".local.meta.json")) {
      stats.localEntries += 1;
    } else if (file.endsWith(".meta.json")) {
      stats.packageEntries += 1;
    }
  }
  return stats;
}

export interface StorePackageOptions {
  analyzedAt: string;
  components: Record<string, string>;
  fingerprint: string;
  id: string;
  kind: CacheEntryKind;
  path: string;
  value: PackageLocalReport | SurfaceReport;
}

export function storePackage(dir: string, entry: StorePackageOptions): void {
  const files = packageFiles(dir, entry.id, entry.kind);
  writeJsonAtomic(files.payload, entry.value);
  const meta: CachedPackageMeta = {
    analyzedAt: entry.analyzedAt,
    cacheSchemaVersion: SEMANTICS_CACHE_SCHEMA_VERSION,
    components: entry.components,
    file: relative(dir, files.payload),
    fingerprint: entry.fingerprint,
    kind: entry.kind,
    packageId: entry.id,
    path: entry.path,
    reportSchemaVersion: entry.value.schemaVersion,
  };
  writeJsonAtomic(files.meta, meta);
}

/** Re-point an entry whose fresh computation reproduced the cached payload. */
export function refreshPackageMeta(
  dir: string,
  meta: CachedPackageMeta,
  next: { fingerprint: string; components: Record<string, string> }
): void {
  const files = packageFiles(dir, meta.packageId, meta.kind);
  writeJsonAtomic(files.meta, {
    ...meta,
    cacheSchemaVersion: SEMANTICS_CACHE_SCHEMA_VERSION,
    components: next.components,
    fingerprint: next.fingerprint,
  });
}

/** Package ids with an entry of `kind` on disk, valid or not. */
export function listCachedPackages(
  dir: string,
  kind: CacheEntryKind = "package-report"
): string[] {
  const packages = join(dir, "packages");
  if (!existsSync(packages)) {
    return [];
  }
  const suffix = kind === "package-local" ? ".local.meta.json" : ".meta.json";
  return readdirSync(packages)
    .filter(
      (file) =>
        file.endsWith(suffix) &&
        (kind === "package-local" || !file.endsWith(".local.meta.json"))
    )
    .map((file) =>
      file.slice(0, -suffix.length).replace(listCachedPackagesPattern, "/")
    )
    .sort();
}

export function removePackage(dir: string, id: string): void {
  for (const kind of ["package-local", "package-report"] as const) {
    const files = packageFiles(dir, id, kind);
    rmSync(files.payload, { force: true });
    rmSync(files.meta, { force: true });
  }
}

const INPUTS_FILE = "workspace-inputs.json";

export function readWorkspaceInputsMeta(
  dir: string
): WorkspaceInputsMeta | undefined {
  const file = join(dir, INPUTS_FILE);
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = readJson(file);
    if (
      !isRecord(parsed) ||
      parsed.cacheSchemaVersion !== SEMANTICS_CACHE_SCHEMA_VERSION ||
      !isRecord(parsed.files)
    ) {
      return undefined;
    }
    const files: Record<string, string> = {};
    for (const [key, hash] of Object.entries(parsed.files)) {
      if (typeof hash === "string") {
        files[key] = hash;
      }
    }
    return { cacheSchemaVersion: SEMANTICS_CACHE_SCHEMA_VERSION, files };
  } catch {
    return undefined;
  }
}

export function storeWorkspaceInputsMeta(
  dir: string,
  files: Map<string, string>
): void {
  const meta: WorkspaceInputsMeta = {
    cacheSchemaVersion: SEMANTICS_CACHE_SCHEMA_VERSION,
    files: Object.fromEntries(files),
  };
  writeJsonAtomic(join(dir, INPUTS_FILE), meta);
}

// ---------------------------------------------------------------------------
// LOCK

interface LockFile {
  pid: number;
  startedAt: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One build per cache directory. A lock left by a dead process is taken
 * over; a live holder fails this build before it touches anything.
 */
export function acquireCacheLock(dir: string): () => void {
  const file = join(dir, "lock.json");
  mkdirSync(dir, { recursive: true });
  if (existsSync(file)) {
    let holder: LockFile | undefined;
    try {
      holder = readJson(file) as LockFile;
    } catch {
      holder = undefined;
    }
    if (
      holder !== undefined &&
      holder.pid !== process.pid &&
      alive(holder.pid)
    ) {
      throw new Error(
        `semantics cache ${dir} is locked by process ${holder.pid} since ${holder.startedAt}`
      );
    }
  }
  const lock: LockFile = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(file, lock);
  return () => {
    try {
      const current = readJson(file) as LockFile;
      if (current.pid === process.pid) {
        rmSync(file, { force: true });
      }
    } catch {
      // already gone
    }
  };
}
