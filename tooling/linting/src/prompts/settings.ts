import { readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  claudeCode,
  codex,
  type Dialect,
  type PromptNames,
  pi,
  type Surface,
} from "@foundry/prompts";

const STOCK_DIALECTS: Readonly<Record<string, Dialect>> = {
  claude: claudeCode,
  codex,
  pi,
};

type StockDialectKey = "claude" | "codex" | "pi";

export interface PromptsSettings {
  readonly agents?: readonly string[];
  readonly dialects?: Readonly<Record<string, StockDialectKey>>;
  readonly skills?: readonly string[];
  readonly surface?: Surface;
}

export interface Resolved {
  readonly dialects: Readonly<Record<string, Dialect>>;
  readonly sources: PromptNames | undefined;
  readonly surface: Surface;
}

const SETTINGS_KEY = "foundry";
const DOMAIN = "prompts";
const SURFACES: ReadonlySet<string> = new Set(["message", "template"]);
const MARKDOWN = /\.md$/;
const LISTING_TTL_MS = 2000;

const listings = new Map<string, { at: number; names: readonly string[] }>();

function fail(message: string): never {
  throw new Error(`settings.${SETTINGS_KEY}.${DOMAIN}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, key: string): readonly string[] {
  if (
    !(Array.isArray(value) && value.every((item) => typeof item === "string"))
  ) {
    fail(`"${key}" must be a list of strings.`);
  }
  return value;
}

function isDirectory(entry: string): boolean {
  return entry.includes("/") || entry.includes("\\") || entry.startsWith(".");
}

function listDirectory(directory: string, kind: "agent" | "skill"): string[] {
  const now = Date.now();
  const cached = listings.get(directory);
  if (cached !== undefined && now - cached.at < LISTING_TTL_MS) {
    return [...cached.names];
  }
  let listed: string[] = [];
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    listed = entries
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) =>
        kind === "skill" ? entry.isDirectory() : MARKDOWN.test(entry.name)
      )
      .map((entry) =>
        kind === "skill" ? entry.name : entry.name.replace(MARKDOWN, "")
      );
  } catch {
    // A directory read failure lists nothing: the kind is covered and no name resolves.
  }
  listings.set(directory, { at: now, names: listed });
  return listed;
}

function names(
  entries: readonly string[],
  kind: "agent" | "skill",
  cwd: string
): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    if (isDirectory(entry)) {
      found.push(
        ...listDirectory(isAbsolute(entry) ? entry : resolve(cwd, entry), kind)
      );
    } else {
      found.push(entry);
    }
  }
  return found;
}

function dialectsFrom(value: unknown): Record<string, Dialect> {
  const dialects: Record<string, Dialect> = Object.assign(
    Object.create(null),
    STOCK_DIALECTS
  );
  if (value === undefined) {
    return dialects;
  }
  if (!isRecord(value)) {
    fail('"dialects" must map member names to "claude", "codex", or "pi".');
  }
  for (const [member, key] of Object.entries(value)) {
    const dialect = typeof key === "string" ? STOCK_DIALECTS[key] : undefined;
    if (dialect === undefined) {
      fail(
        `"dialects.${member}" must be "claude", "codex", or "pi", not ${JSON.stringify(key)}.`
      );
    }
    dialects[member] = dialect;
  }
  return dialects;
}

export function resolveSettings(
  settings: Readonly<Record<string, unknown>>,
  cwd: string
): Resolved {
  const all = settings[SETTINGS_KEY];
  if (all !== undefined && !isRecord(all)) {
    throw new Error(`settings.${SETTINGS_KEY}: must be an object.`);
  }
  const raw = all?.[DOMAIN];
  if (raw === undefined) {
    return { dialects: STOCK_DIALECTS, sources: undefined, surface: "message" };
  }
  if (!isRecord(raw)) {
    fail("must be an object.");
  }
  const surface = raw.surface ?? "message";
  if (typeof surface !== "string" || !SURFACES.has(surface)) {
    fail('"surface" must be "message" or "template".');
  }
  const sources: PromptNames = {};
  if (raw.skills !== undefined) {
    sources.skill = names(stringList(raw.skills, "skills"), "skill", cwd);
  }
  if (raw.agents !== undefined) {
    sources.agent = names(stringList(raw.agents, "agents"), "agent", cwd);
  }
  return {
    dialects: dialectsFrom(raw.dialects),
    sources:
      raw.skills === undefined && raw.agents === undefined
        ? undefined
        : sources,
    surface: surface as Surface,
  };
}
