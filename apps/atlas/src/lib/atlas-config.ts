import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { normalizeWorkspacePath } from "./boundary";
import type { DomainDeclaration } from "./domain-declaration";
import { domainsSchema } from "./domain-declaration";
import type { Rule } from "./rule-declaration";
import { rulesSchema } from "./rule-declaration";
import { HISTORY_RANGE } from "./semantics-history-timeline";
import { SEMANTICS_HISTORY_STRATEGIES } from "./semantics-history-types";
import type { SemanticsConfig } from "./semantics-types";
import { WORKER_RUNTIME, workerEntry } from "./worker-runtime";

// A workspace's configuration, in two layers. `AtlasConfig` is what one
// configuration file in `.foundry/atlas/` declares, or during 0.x what
// `foundry.config.json#semantics` declares. The resolved configuration
// (`SemanticsConfig`) is those declarations over the defaults, and is what a
// scan runs under.
//
// Execution invariants. Configuration files are TypeScript or JavaScript, so
// loading them runs the workspace's code with the user's privileges. Only
// the scan entry points load it, once per call, from the working tree;
// `serve` and the dataset reader never do, and history applies that one
// configuration to every checkpoint, never a checkpoint's own. The files run
// in a fresh Bun worker, so every load sees the current files, and the
// configuration crosses back as JSON that is validated again here. A worker
// that outlives its timeout is killed; processes a configuration file starts
// itself are not.

/** What one configuration file default-exports. Each key may be declared in one file only. */
export interface AtlasConfig {
  /** The workspace's domains: what a lens reads, never an analysis. */
  domains?: DomainDeclaration[];
  /** Workspace-relative unit directories to skip (`packages/fixtures`), matched exactly. */
  exclude?: string[];
  /** The checkpoint policy of `scan --history`; unset fields keep their defaults. */
  history?: {
    /** Upper bound on checkpoints; `HEAD` always counts. A whole number of at least 1. */
    checkpoints?: number;
    /** Commit stride for `every-n-commits`. A whole number of at least 1. */
    every?: number;
    /** How far back from `HEAD`: `<n>y`, `<n>m` (months), `<n>d`, or `all`. */
    range?: string;
    strategy?: (typeof SEMANTICS_HISTORY_STRATEGIES)[number];
  };
  /** What the workspace permits or requires of its own structure: read by `check` and the codemods, never an analysis. */
  rules?: Rule[];
}

/** The configuration directory, relative to the workspace root. */
export const CONFIG_DIRECTORY = ".foundry/atlas";
const LEGACY_FILE = "foundry.config.json";
const CONFIG_TIMEOUT_MS = 30_000;
const MS_PER_SECOND = 1000;
const CONFIG_WORKER = workerEntry("config-worker");

/** The resolved configuration of a workspace that declares nothing. */
export const DEFAULT_CONFIGURATION: SemanticsConfig = {
  domains: [],
  exclude: [],
  history: {
    checkpoints: 12,
    every: 100,
    range: "1y",
    strategy: "monthly",
  },
  rules: [],
};

const DIRECTORY = "must be a workspace-relative directory";
const WHOLE = "must be a whole number of at least 1";
const RANGE = "must be <n>y, <n>m, <n>d, or all";

const workspaceDirectory = z
  .string({ error: DIRECTORY })
  .transform((path, context) => {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === undefined) {
      context.issues.push({ code: "custom", input: path, message: DIRECTORY });
      return z.NEVER;
    }
    return normalized;
  });

const wholeNumber = z
  .number({ error: WHOLE })
  .int({ error: WHOLE })
  .min(1, { error: WHOLE });

const configSchema = z.strictObject({
  domains: domainsSchema.optional(),
  exclude: z
    .array(workspaceDirectory, {
      error: "must be a list of workspace-relative directories",
    })
    .optional(),
  history: z
    .strictObject(
      {
        checkpoints: wholeNumber.optional(),
        every: wholeNumber.optional(),
        range: z
          .string({ error: RANGE })
          .refine((range) => range === "all" || HISTORY_RANGE.test(range), {
            error: RANGE,
          })
          .optional(),
        strategy: z
          .enum(SEMANTICS_HISTORY_STRATEGIES, {
            error: `must be ${SEMANTICS_HISTORY_STRATEGIES.slice(0, -1).join(", ")}, or ${SEMANTICS_HISTORY_STRATEGIES.at(-1)}`,
          })
          .optional(),
      },
      { error: "must be an object" }
    )
    .optional(),
  rules: rulesSchema.optional(),
}) satisfies z.ZodType<AtlasConfig, unknown>;

/** `foundry.config.json#semantics` declares no domains or rules; they live in `.foundry/atlas/` only. */
const legacySchema = configSchema.omit({ domains: true, rules: true });

/** A value as an error message shows it after "got". */
function shown(value: unknown): string {
  if (typeof value === "function") {
    return "a function";
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return "an object";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return value === undefined ? "nothing" : String(value);
}

function settingPath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) => {
      if (typeof segment === "number") {
        return `[${segment}]`;
      }
      return index === 0 ? String(segment) : `.${String(segment)}`;
    })
    .join("");
}

/**
 * "; got <value>" for an issue, except one marked `wholeObject`: an issue
 * about a whole object, such as a domain, which its message names.
 */
function shownInput(issue: z.core.$ZodIssue): string {
  if (!("input" in issue)) {
    return "";
  }
  if (issue.code === "custom" && issue.params?.wholeObject === true) {
    return "";
  }
  return `; got ${shown(issue.input)}`;
}

/** One clause per setting: the first issue at each path, with the value it got. */
function issueClauses(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly string[]
): string[] {
  const clauses = new Map<string, string>();
  for (const issue of issues) {
    const path = settingPath([...prefix, ...issue.path]);
    if (clauses.has(path)) {
      continue;
    }
    if (issue.code === "unrecognized_keys") {
      const keys = `unknown key${issue.keys.length > 1 ? "s" : ""} ${issue.keys.join(", ")}`;
      clauses.set(path, path === "" ? keys : `${path} has ${keys}`);
    } else {
      const got = shownInput(issue);
      clauses.set(path, `${path} ${issue.message}${got}`);
    }
  }
  return [...clauses.values()];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parsed(
  value: unknown,
  subject: string,
  prefix: readonly string[],
  schema: z.ZodType<AtlasConfig, unknown>
): AtlasConfig {
  const result = schema.safeParse(value, { reportInput: true });
  if (!result.success) {
    throw new Error(
      `${subject}: ${issueClauses(result.error.issues, prefix).join("; ")}.`
    );
  }
  return result.data;
}

/** Validates one configuration file's default export; `file` is workspace-relative. */
export function parseConfigFile(value: unknown, file: string): AtlasConfig {
  if (!isPlainObject(value)) {
    throw new Error(
      `Configuration ${file}: the default export must be an object.`
    );
  }
  return parsed(value, `Configuration ${file}`, [], configSchema);
}

const CONFIG_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/;

/**
 * The configuration files under `directory`, sorted, as Marbles walks
 * `.foundry/marbles/`: names starting with `_` or `.` and `node_modules` are
 * skipped, so `_`-prefixed files can hold helpers; declaration files are
 * skipped; symlinks are not followed.
 */
export function configFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (
        entry.name.startsWith("_") ||
        entry.name.startsWith(".") ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile() &&
        CONFIG_FILE_EXTENSIONS.has(extname(path)) &&
        !DECLARATION_FILE.test(path)
      ) {
        files.push(path);
      }
    }
  };
  visit(directory);
  return files.sort();
}

/** One configuration file's validated default export. */
export interface ConfigFile {
  config: AtlasConfig;
  /** Workspace-relative. */
  file: string;
}

/**
 * What the configuration worker writes to its result file: `loading` names
 * the file being imported, and is replaced by every file's export or by the
 * first failure. A `loading` report that remains means that file ended the
 * process.
 */
export type ConfigWorkerReport =
  | { files: ConfigFile[] }
  | { error: string }
  | { loading: string };

const execFileAsync = promisify(execFile);

/** The worker's report, validated; undefined when it wrote none. */
function readWorkerReport(out: string): ConfigWorkerReport | undefined {
  if (!existsSync(out)) {
    return;
  }
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch (error) {
    throw new Error(
      `Configuration: loading ${CONFIG_DIRECTORY}/ returned an unreadable result.`,
      { cause: error }
    );
  }
  if (isPlainObject(report)) {
    const { error, files, loading } = report;
    if (typeof error === "string") {
      return { error };
    }
    if (typeof loading === "string") {
      return { loading };
    }
    if (Array.isArray(files)) {
      return { files: files.map(reportedFile) };
    }
  }
  throw new Error(
    `Configuration: loading ${CONFIG_DIRECTORY}/ returned an unexpected result.`
  );
}

/** One file of the worker's report, validated again on this side of the process boundary. */
function reportedFile(entry: unknown): ConfigFile {
  if (!(isPlainObject(entry) && typeof entry.file === "string")) {
    throw new Error(
      `Configuration: loading ${CONFIG_DIRECTORY}/ returned an unexpected result.`
    );
  }
  return {
    config: parseConfigFile(entry.config, entry.file),
    file: entry.file,
  };
}

/** The last line a failed process wrote to stderr, or its error message. */
function lastLine(failure: unknown): string | undefined {
  if (failure === undefined) {
    return;
  }
  const { message, stderr } = failure as { message?: string; stderr?: string };
  return (stderr?.trim() || message || String(failure)).split("\n").at(-1);
}

/** Loads every configuration file in a fresh Bun worker, killed if it outlives `timeoutMs`. */
async function loadConfigDirectory(
  root: string,
  timeoutMs: number
): Promise<ConfigFile[]> {
  const scratch = mkdtempSync(join(tmpdir(), "atlas-config-"));
  const out = join(scratch, "config.json");
  try {
    let failure: unknown;
    try {
      await execFileAsync(WORKER_RUNTIME, [CONFIG_WORKER, root, out], {
        cwd: root,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
      });
    } catch (error) {
      if ((error as { killed?: boolean }).killed === true) {
        throw new Error(
          `Configuration: ${CONFIG_DIRECTORY}/ did not finish loading within ${timeoutMs / MS_PER_SECOND} seconds.`,
          { cause: error }
        );
      }
      failure = error;
    }
    const report = readWorkerReport(out);
    if (report !== undefined && "files" in report) {
      return report.files;
    }
    if (report !== undefined && "error" in report) {
      throw new Error(report.error);
    }
    const detail = lastLine(failure);
    if (report !== undefined) {
      throw new Error(
        `Configuration ${report.loading}: the file ended the process while it was loading${detail === undefined ? "." : `: ${detail}`}`
      );
    }
    throw new Error(
      `Configuration: Bun could not load ${CONFIG_DIRECTORY}/${detail === undefined ? "." : `: ${detail}`}`,
      { cause: failure }
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

/** One configuration from many files; a key declared in two files is an error. */
function combined(files: readonly ConfigFile[]): AtlasConfig {
  const declaredIn = new Map<string, string>();
  const merged: AtlasConfig = {};
  for (const { config, file } of files) {
    for (const key of Object.keys(config)) {
      const first = declaredIn.get(key);
      if (first !== undefined) {
        throw new Error(
          `Configuration: ${key} is declared in ${first} and ${file}. Declare it in one.`
        );
      }
      declaredIn.set(key, file);
    }
    Object.assign(merged, config);
  }
  return merged;
}

function withDefaults(config: AtlasConfig): SemanticsConfig {
  return {
    domains: config.domains ?? DEFAULT_CONFIGURATION.domains,
    exclude: config.exclude ?? DEFAULT_CONFIGURATION.exclude,
    history: { ...DEFAULT_CONFIGURATION.history, ...config.history },
    rules: config.rules ?? DEFAULT_CONFIGURATION.rules,
  };
}

const REMOVED_LEGACY_SETTINGS: Record<string, string> = {
  output: "the dataset is saved under the state directory",
  roots:
    "Atlas finds packages from the workspace declaration (pnpm-workspace.yaml or package.json#workspaces)",
};

/** `foundry.config.json`, parsed; undefined when the file is absent. */
function readLegacyFile(root: string): Record<string, unknown> | undefined {
  const file = join(root, LEGACY_FILE);
  if (!existsSync(file)) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${LEGACY_FILE}: the file is not valid JSON: ${reason}`, {
      cause: error,
    });
  }
  if (!isPlainObject(value)) {
    throw new Error(`${LEGACY_FILE}: the file must hold an object.`);
  }
  return value;
}

/** Whether `foundry.config.json` has a `semantics` key; a file that does not parse has none. */
function legacyFileDeclares(root: string): boolean {
  try {
    const legacy = readLegacyFile(root);
    return legacy !== undefined && "semantics" in legacy;
  } catch {
    return false;
  }
}

/** `foundry.config.json#semantics`, validated: the 0.x fallback. */
function legacyConfig(semantics: unknown): AtlasConfig {
  if (!isPlainObject(semantics)) {
    throw new Error(`${LEGACY_FILE}: semantics must be an object.`);
  }
  const removed = Object.keys(REMOVED_LEGACY_SETTINGS)
    .filter((key) => key in semantics)
    .map(
      (key) =>
        `semantics.${key} is no longer read; ${REMOVED_LEGACY_SETTINGS[key]}. Remove it.`
    );
  if (removed.length > 0) {
    throw new Error(`${LEGACY_FILE}: ${removed.join(" ")}`);
  }
  return parsed(semantics, LEGACY_FILE, ["semantics"], legacySchema);
}

/**
 * The configuration directory, when the workspace has one. A directory
 * reached through a symbolic link, at `.foundry` or at `.foundry/atlas`, is
 * refused rather than followed.
 */
function configDirectory(root: string): string | undefined {
  const directory = join(root, CONFIG_DIRECTORY);
  if (!existsSync(directory)) {
    return;
  }
  for (const path of [".foundry", CONFIG_DIRECTORY]) {
    if (lstatSync(join(root, path)).isSymbolicLink()) {
      throw new Error(
        `Configuration: ${path} is a symbolic link; Atlas does not follow links.`
      );
    }
  }
  return statSync(directory).isDirectory() ? directory : undefined;
}

export interface LoadConfigurationOptions {
  /** How long the configuration files may take to load. Default 30 seconds. */
  timeoutMs?: number;
}

/**
 * The resolved configuration: the configuration directory's declarations
 * when it exists, else `foundry.config.json#semantics`, over the defaults.
 * Runs the workspace's configuration files; see the execution invariants
 * above. A failure names the file to blame when there is one, and the
 * setting when a value is wrong.
 */
export async function loadConfiguration(
  root: string,
  options: LoadConfigurationOptions = {}
): Promise<SemanticsConfig> {
  const directory = configDirectory(root);
  if (directory !== undefined) {
    if (legacyFileDeclares(root)) {
      throw new Error(
        `${LEGACY_FILE}: semantics is ignored because ${CONFIG_DIRECTORY}/ exists. Move it there, or remove it.`
      );
    }
    if (configFiles(directory).length === 0) {
      return DEFAULT_CONFIGURATION;
    }
    return withDefaults(
      combined(
        await loadConfigDirectory(root, options.timeoutMs ?? CONFIG_TIMEOUT_MS)
      )
    );
  }
  const legacy = readLegacyFile(root);
  if (legacy === undefined || !("semantics" in legacy)) {
    return DEFAULT_CONFIGURATION;
  }
  return withDefaults(legacyConfig(legacy.semantics));
}
