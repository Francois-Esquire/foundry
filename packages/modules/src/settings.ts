import { byCodeUnit } from "@foundry/lib/ordering";

/**
 * Per-Module settings: limits and preferences named by dot-notation keys. A
 * strict Manifest declares requests/defaults, the host stores user values by
 * Module ID, and host ceilings cap both. Settings never grant authority:
 * network, Artifact access beyond bindings and host operations are Grants.
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

interface HostSetting {
  /** No effective value exceeds it; a requirement above it is unmet. */
  readonly ceiling: number;
  /** Used when neither the user nor the Manifest chose a value. */
  readonly default: number;
  /** Whole numbers only; every value is positive either way. */
  readonly integer: boolean;
  readonly unit: string;
}

/**
 * Host defaults and ceilings (spec §10). The values are the recommended
 * starting points, kept as code constants until measurements select others.
 */
export const MODULE_SETTING_HOST_POLICY = {
  "artifacts.chunkBytes": setting(256 * KIB, 256 * KIB, "bytes"),
  "artifacts.maxFileBytes": setting(16 * MIB, 16 * MIB, "bytes"),
  "audit.maxTerminalEntries": setting(10_000, 10_000, "entries"),
  "audit.retentionDays": setting(30, 30, "days"),
  "authoring.deadline": setting(10 * 60 * 1000, 10 * 60 * 1000, "ms"),
  "authoring.maxSteps": setting(20, 20, "steps"),
  "authoring.source.maxBytes": setting(16_777_216, 16_777_216, "bytes"),
  "authoring.source.maxFileCodeUnits": setting(
    4_194_304,
    4_194_304,
    "UTF-16 code units"
  ),
  "authoring.source.maxFiles": setting(2048, 2048, "files"),
  "authoring.source.maxPathCharacters": setting(512, 512, "characters"),
  "explorer.pageSize": setting(100, 100, "entries"),
  // Authoring turns of one Module share its workspace and Agent Session, so
  // more than one at a time is unsupported: the ceiling is 1.
  "queues.authoring.concurrency": setting(1, 1, "runs"),
  "queues.workflows.concurrency": setting(1, 4, "runs"),
  "resources.cpus": { ceiling: 2, default: 1, integer: false, unit: "CPUs" },
  // The shared Module sandbox's default; a host may start another kind of
  // sandbox (a released Program) from its own default under the same ceiling.
  "resources.memoryBytes": setting(2 * GIB, 2 * GIB, "bytes"),
} as const satisfies Readonly<Record<string, HostSetting>>;

export type ModuleSettingKey = keyof typeof MODULE_SETTING_HOST_POLICY;
export type ModuleSettingsHostPolicy = Readonly<
  Record<ModuleSettingKey, HostSetting>
>;

export const MODULE_SETTING_KEYS = Object.freeze(
  Object.keys(MODULE_SETTING_HOST_POLICY).sort() as ModuleSettingKey[]
);

/** Keys a Manifest requests through its top-level `resources`, not `settings`. */
export const MODULE_RESOURCE_SETTING_KEYS = Object.freeze([
  "resources.cpus",
  "resources.memoryBytes",
] as const satisfies readonly ModuleSettingKey[]);

/** Authority, requested as Capabilities or `network` and approved as Grants. */
export const MODULE_GRANT_KEYS = Object.freeze([
  "artifacts.access",
  "host.operations",
  "network",
] as const);

/** The one phase-one sandbox lifecycle rule: on while its Module is on. */
export const MODULE_SANDBOX_IDLE_POLICY = "keep-on" as const;

export type ModuleSettingValues = Readonly<
  Partial<Record<ModuleSettingKey, number>>
>;

export type EffectiveModuleSettings = Readonly<
  Record<ModuleSettingKey, number>
> & {
  readonly "sandbox.idlePolicy": typeof MODULE_SANDBOX_IDLE_POLICY;
};

export interface ModuleSettingProblem {
  readonly key: string;
  readonly message: string;
}

export type ModuleSettingsResolution =
  | { readonly effective: EffectiveModuleSettings; readonly ok: true }
  | { readonly ok: false; readonly problems: readonly ModuleSettingProblem[] };

export class ModuleSettingsError extends Error {
  readonly problems: readonly ModuleSettingProblem[];

  constructor(problems: readonly ModuleSettingProblem[]) {
    super(
      `Module settings cannot be met: ${problems.map((problem) => problem.message).join("; ")}`
    );
    this.name = "ModuleSettingsError";
    this.problems = problems;
  }
}

/**
 * `key` as a setting anyone may choose, or why it is not one. Shared by
 * Manifest validation and user values, so both say the same thing.
 */
export function parseModuleSettingKey(
  key: string
): { readonly key: ModuleSettingKey } | { readonly problem: string } {
  if ((MODULE_GRANT_KEYS as readonly string[]).includes(key)) {
    return {
      problem: `${key} is authority, not a setting: request it as a Capability or network access and approve it as a Grant`,
    };
  }
  if (key === "sandbox.idlePolicy") {
    return {
      problem:
        "sandbox.idlePolicy is fixed: a Module's sandbox stays on while the Module is on",
    };
  }
  return isModuleSettingKey(key)
    ? { key }
    : { problem: `${key} is not a Module setting` };
}

function isModuleSettingKey(key: string): key is ModuleSettingKey {
  return Object.hasOwn(MODULE_SETTING_HOST_POLICY, key);
}

/** Whether `key` is requested through a Manifest's `resources`, not `settings`. */
export function isResourceSettingKey(
  key: string
): key is (typeof MODULE_RESOURCE_SETTING_KEYS)[number] {
  return (MODULE_RESOURCE_SETTING_KEYS as readonly string[]).includes(key);
}

/** Why `value` cannot be a value of `key`, or `null` when its shape is valid. */
export function moduleSettingValueProblem(
  key: ModuleSettingKey,
  value: unknown,
  policy: ModuleSettingsHostPolicy = MODULE_SETTING_HOST_POLICY
): string | null {
  const host = policy[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (host.integer && !Number.isSafeInteger(value))
  ) {
    return `${key} must be a positive ${host.integer ? "integer" : "number"} of ${host.unit}`;
  }
  return null;
}

/**
 * Validates user values for storage. Each key must be a setting, each value
 * positive and within the host ceiling. Unknown, authority and fixed keys
 * are rejected rather than dropped.
 */
export function parseModuleSettingValues(
  input: unknown,
  policy: ModuleSettingsHostPolicy = MODULE_SETTING_HOST_POLICY
): ModuleSettingValues {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ModuleSettingsError([
      { key: "", message: "Module settings must be an object" },
    ]);
  }
  const problems: ModuleSettingProblem[] = [];
  const values: Partial<Record<ModuleSettingKey, number>> = {};
  for (const [name, value] of Object.entries(input)) {
    const parsed = parseModuleSettingKey(name);
    if ("problem" in parsed) {
      problems.push({ key: name, message: parsed.problem });
      continue;
    }
    const { key } = parsed;
    const valueProblem = moduleSettingValueProblem(key, value, policy);
    if (valueProblem !== null) {
      problems.push({ key, message: valueProblem });
      continue;
    }
    const number = value as number;
    if (number > policy[key].ceiling) {
      problems.push({ key, message: aboveCeiling(key, number, policy) });
      continue;
    }
    values[key] = number;
  }
  if (problems.length > 0) {
    throw new ModuleSettingsError(problems);
  }
  return Object.freeze(sortedValues(values));
}

/**
 * Effective values for one Module: the user's choice, else the Manifest's
 * default, else the host default; never below a Manifest minimum and never
 * above a host ceiling. A Manifest default above the ceiling is capped (it
 * is a preference). A requirement the host or the user's value cannot meet
 * is a problem, not a smaller allocation. `requests` are what the Module's
 * Manifest declares (`moduleSettingRequests`).
 */
export function resolveModuleSettings(input: {
  readonly requests: ModuleSettingRequests;
  readonly user?: ModuleSettingValues;
  readonly policy?: ModuleSettingsHostPolicy;
}): ModuleSettingsResolution {
  const policy = input.policy ?? MODULE_SETTING_HOST_POLICY;
  const { requests } = input;
  const problems: ModuleSettingProblem[] = [];
  const effective: Partial<Record<ModuleSettingKey, number>> = {};
  for (const key of MODULE_SETTING_KEYS) {
    const resolved = resolveSetting(
      key,
      policy,
      requests[key],
      input.user?.[key]
    );
    if (typeof resolved === "string") {
      problems.push({ key, message: resolved });
    } else {
      effective[key] = resolved;
    }
  }
  if (problems.length > 0) {
    return { ok: false, problems: Object.freeze(problems) };
  }
  return {
    effective: Object.freeze({
      ...(effective as Record<ModuleSettingKey, number>),
      "sandbox.idlePolicy": MODULE_SANDBOX_IDLE_POLICY,
    }),
    ok: true,
  };
}

/** One key's effective value, or why it cannot be met. */
function resolveSetting(
  key: ModuleSettingKey,
  policy: ModuleSettingsHostPolicy,
  request: ModuleSettingRequest | undefined,
  user: number | undefined
): number | string {
  const host = policy[key];
  const minimum = request?.minimum;
  if (minimum !== undefined && minimum > host.ceiling) {
    return `The Module requires ${key} of at least ${minimum} ${host.unit}; this host allows at most ${host.ceiling}`;
  }
  if (user === undefined) {
    const preferred = request?.default ?? host.default;
    return Math.min(Math.max(preferred, minimum ?? 0), host.ceiling);
  }
  const problem = moduleSettingValueProblem(key, user, policy);
  if (problem !== null) {
    return problem;
  }
  if (user > host.ceiling) {
    return aboveCeiling(key, user, policy);
  }
  if (minimum !== undefined && user < minimum) {
    return `${key} is set to ${user} ${host.unit}; the Module requires at least ${minimum}`;
  }
  return user;
}

/** {@link resolveModuleSettings}, throwing {@link ModuleSettingsError} when unmet. */
export function requireModuleSettings(
  input: Parameters<typeof resolveModuleSettings>[0]
): EffectiveModuleSettings {
  const resolution = resolveModuleSettings(input);
  if (!resolution.ok) {
    throw new ModuleSettingsError(resolution.problems);
  }
  return resolution.effective;
}

/** The host policy with some defaults replaced, such as another sandbox's memory. */
export function withModuleSettingDefaults(
  defaults: ModuleSettingValues,
  policy: ModuleSettingsHostPolicy = MODULE_SETTING_HOST_POLICY
): ModuleSettingsHostPolicy {
  const next: Record<ModuleSettingKey, HostSetting> = { ...policy };
  for (const [key, value] of Object.entries(defaults) as [
    ModuleSettingKey,
    number,
  ][]) {
    next[key] = {
      ...policy[key],
      default: Math.min(value, policy[key].ceiling),
    };
  }
  return Object.freeze(next);
}

export interface ModuleSettingRequest {
  readonly default?: number;
  readonly minimum?: number;
}

/** What a Module asks of each setting: a minimum and/or a default. */
export type ModuleSettingRequests = Readonly<
  Partial<Record<ModuleSettingKey, ModuleSettingRequest>>
>;

function aboveCeiling(
  key: ModuleSettingKey,
  value: number,
  policy: ModuleSettingsHostPolicy
): string {
  const host = policy[key];
  return `${key} is set to ${value} ${host.unit}; this host allows at most ${host.ceiling}`;
}

function sortedValues(
  values: Partial<Record<ModuleSettingKey, number>>
): Partial<Record<ModuleSettingKey, number>> {
  return Object.fromEntries(
    Object.entries(values).sort(byCodeUnit(([key]) => key))
  );
}

function setting(
  defaultValue: number,
  ceiling: number,
  unit: string
): HostSetting {
  return { ceiling, default: defaultValue, integer: true, unit };
}
