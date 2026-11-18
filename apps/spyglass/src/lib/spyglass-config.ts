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

export interface SpyglassConfig {
  domains?: DomainDeclaration[];
  exclude?: string[];
  history?: {
    checkpoints?: number;
    every?: number;
    range?: string;
    strategy?: (typeof SEMANTICS_HISTORY_STRATEGIES)[number];
  };
  rules?: Rule[];
}

const CONFIG_DIRECTORY = ".foundry/spyglass";
const LEGACY_CONFIG_DIRECTORY = ".foundry/atlas";
const LEGACY_FILE = "foundry.config.json";
const CONFIG_TIMEOUT_MS = 30_000;
const MS_PER_SECOND = 1000;
const CONFIG_WORKER = workerEntry("config-worker");

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
}) satisfies z.ZodType<SpyglassConfig, unknown>;

const legacySchema = configSchema.omit({ domains: true, rules: true });

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

function shownInput(issue: z.core.$ZodIssue): string {
  if (!("input" in issue)) {
    return "";
  }
  if (issue.code === "custom" && issue.params?.wholeObject === true) {
    return "";
  }
  return `; got ${shown(issue.input)}`;
}

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
  schema: z.ZodType<SpyglassConfig, unknown>
): SpyglassConfig {
  const result = schema.safeParse(value, { reportInput: true });
  if (!result.success) {
    throw new Error(
      `${subject}: ${issueClauses(result.error.issues, prefix).join("; ")}.`
    );
  }
  return result.data;
}

export function parseConfigFile(value: unknown, file: string): SpyglassConfig {
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

export interface ConfigFile {
  config: SpyglassConfig;
  file: string;
}

export type ConfigWorkerReport =
  | { files: ConfigFile[] }
  | { error: string }
  | { loading: string };

const execFileAsync = promisify(execFile);

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

function lastLine(failure: unknown): string | undefined {
  if (failure === undefined) {
    return;
  }
  const { message, stderr } = failure as { message?: string; stderr?: string };
  return (stderr?.trim() || message || String(failure)).split("\n").at(-1);
}

async function loadConfigDirectory(
  root: string,
  directory: string,
  timeoutMs: number
): Promise<ConfigFile[]> {
  const scratch = mkdtempSync(join(tmpdir(), "spyglass-config-"));
  const out = join(scratch, "config.json");
  try {
    let failure: unknown;
    try {
      await execFileAsync(
        WORKER_RUNTIME,
        [CONFIG_WORKER, root, out, directory],
        {
          cwd: root,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
          timeout: timeoutMs,
        }
      );
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

function combined(files: readonly ConfigFile[]): SpyglassConfig {
  const declaredIn = new Map<string, string>();
  const merged: SpyglassConfig = {};
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

function withDefaults(config: SpyglassConfig): SemanticsConfig {
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
    "Spyglass finds packages from the workspace declaration (pnpm-workspace.yaml or package.json#workspaces)",
};

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

function legacyFileDeclares(root: string): boolean {
  try {
    const legacy = readLegacyFile(root);
    return legacy !== undefined && "semantics" in legacy;
  } catch {
    return false;
  }
}

function legacyConfig(semantics: unknown): SpyglassConfig {
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

function configDirectory(root: string): string | undefined {
  const selected = existsSync(join(root, CONFIG_DIRECTORY))
    ? CONFIG_DIRECTORY
    : LEGACY_CONFIG_DIRECTORY;
  const directory = join(root, selected);
  if (!existsSync(directory)) {
    return;
  }
  for (const path of [".foundry", selected]) {
    if (lstatSync(join(root, path)).isSymbolicLink()) {
      throw new Error(
        `Configuration: ${path} is a symbolic link; Spyglass does not follow links.`
      );
    }
  }
  return statSync(directory).isDirectory() ? directory : undefined;
}

export interface LoadConfigurationOptions {
  timeoutMs?: number;
}

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
        await loadConfigDirectory(
          root,
          directory,
          options.timeoutMs ?? CONFIG_TIMEOUT_MS
        )
      )
    );
  }
  const legacy = readLegacyFile(root);
  if (legacy === undefined || !("semantics" in legacy)) {
    return DEFAULT_CONFIGURATION;
  }
  return withDefaults(legacyConfig(legacy.semantics));
}
