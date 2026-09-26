import * as fs from "node:fs";
import * as path from "node:path";
import { ingestWorkspaceReports } from "./workspace-ingest";
import type {
  WorkspaceIngestOptions,
  WorkspaceReport,
} from "./workspace-types";

// File-based wrapper around the pure ingestion API. Resolves what to read,
// parses it, and hands the raw values on; shape and schema decisions stay in
// `validateWorkspaceInput`, so a bad file becomes a diagnostic, not a throw.

export interface WorkspaceLoadOptions extends WorkspaceIngestOptions {
  /** A directory of `*.json` reports, a manifest `{ "reports": [...] }`, or report files. */
  paths: string[];
}

function manifestEntries(file: string): string[] | undefined {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "reports" in parsed &&
    Array.isArray(parsed.reports) &&
    !("schemaVersion" in parsed) &&
    !("report" in parsed)
  ) {
    return parsed.reports
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => path.resolve(path.dirname(file), entry));
  }
  return undefined;
}

/** Expands directories and manifests to report files, sorted for determinism. */
export function resolveWorkspaceReportFiles(paths: string[]): string[] {
  const files = new Set<string>();
  for (const given of paths) {
    const resolved = path.resolve(given);
    if (fs.statSync(resolved).isDirectory()) {
      for (const entry of fs.readdirSync(resolved)) {
        if (entry.endsWith(".json")) {
          files.add(path.join(resolved, entry));
        }
      }
      continue;
    }
    const listed = manifestEntries(resolved);
    if (listed === undefined) {
      files.add(resolved);
    } else {
      for (const entry of listed) {
        files.add(entry);
      }
    }
  }
  return [...files].sort();
}

export function loadWorkspaceReports(options: WorkspaceLoadOptions): {
  report: WorkspaceReport;
  files: string[];
  inputBytes: number;
  /** The parsed inputs, for callers that need package-level facts the workspace only digests. */
  inputs: unknown[];
} {
  const { paths, ...ingest } = options;
  const files = resolveWorkspaceReportFiles(paths);
  let inputBytes = 0;
  const inputs = files.map((file): unknown => {
    const text = fs.readFileSync(file, "utf8");
    inputBytes += Buffer.byteLength(text);
    return JSON.parse(text);
  });
  return {
    files,
    inputBytes,
    inputs,
    report: ingestWorkspaceReports(inputs, ingest),
  };
}
