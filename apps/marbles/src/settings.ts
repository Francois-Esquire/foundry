import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isRecord, writeJson } from "~/lib/state/json";
import { THEME_NAMES, type ThemeName } from "~/model/settings";

/**
 * Global Marbles preferences: one JSON file at the state root
 * (`~/.foundry/marbles/settings.json` unless `--state` moves it), shared by
 * every workspace. Defaults apply to whatever the file does not set, or sets
 * to something Marbles does not know; a file that cannot be read leaves the
 * defaults in place and is not overwritten. Keys this version does not know
 * are kept when it saves.
 */

const THEMES: readonly ThemeName[] = THEME_NAMES;

export interface Settings {
  readonly theme: ThemeName;
}

export const DEFAULT_SETTINGS: Settings = { theme: "dark" };

export interface LoadedSettings {
  readonly path: string;
  /** Why some or all of the file was not used. */
  readonly problem?: string;
  readonly settings: Settings;
}

/** Workspace dirs under the state root are hashes, so this name never collides with one. */
export function settingsPath(stateRoot: string): string {
  return join(resolve(stateRoot), "settings.json");
}

function isTheme(value: unknown): value is ThemeName {
  return THEMES.includes(value as ThemeName);
}

type Parsed =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "read"; readonly value: Record<string, unknown> };

function parse(path: string): Parsed {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return {
      kind: "invalid",
      problem: `${path} could not be read: ${String(error)}`,
    };
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value)
      ? { kind: "read", value }
      : { kind: "invalid", problem: `${path} is not a JSON object` };
  } catch {
    return { kind: "invalid", problem: `${path} is not valid JSON` };
  }
}

/**
 * Load preferences from `path`. A missing file uses defaults; an unreadable
 * or invalid file, or an unknown theme, uses defaults and reports a problem.
 */
export function loadSettings(path: string): LoadedSettings {
  const parsed = parse(path);
  if (parsed.kind === "missing") {
    return { path, settings: DEFAULT_SETTINGS };
  }
  if (parsed.kind === "invalid") {
    return {
      path,
      problem: `${parsed.problem}; using defaults`,
      settings: DEFAULT_SETTINGS,
    };
  }
  const { theme } = parsed.value;
  if (theme === undefined || isTheme(theme)) {
    return { path, settings: { theme: theme ?? DEFAULT_SETTINGS.theme } };
  }
  return {
    path,
    problem: `theme ${JSON.stringify(theme)} in ${path} is not one of ${THEMES.join(", ")}; using ${DEFAULT_SETTINGS.theme}`,
    settings: DEFAULT_SETTINGS,
  };
}

/**
 * Write `changes` over what the file holds and return the result. Refuses a
 * file it cannot read rather than replace something a person may want back.
 * Throws for an invalid file or theme, and propagates filesystem write errors.
 */
export function saveSettings(
  path: string,
  changes: Partial<Settings>
): Settings {
  const parsed = parse(path);
  if (parsed.kind === "invalid") {
    throw new Error(`${parsed.problem}; fix or remove it to save settings`);
  }
  if (changes.theme !== undefined && !isTheme(changes.theme)) {
    throw new Error(`theme must be one of ${THEMES.join(", ")}`);
  }
  const current = parsed.kind === "read" ? parsed.value : {};
  const next = { ...current, ...changes };
  writeJson(path, next);
  return loadSettings(path).settings;
}
