import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isRecord, writeJson } from "~/lib/state/json";
import { isTheme, type ThemeName } from "~/model/settings";

export interface Settings {
  readonly providerSetupComplete?: true;
  readonly theme: ThemeName;
}

export const DEFAULT_SETTINGS: Settings = { theme: "dark" };

export interface LoadedSettings {
  readonly path: string;
  readonly problem?: string;
  readonly settings: Settings;
}

export function settingsPath(stateRoot: string): string {
  return join(resolve(stateRoot), "settings.json");
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
  const { providerSetupComplete, theme } = parsed.value;
  const setup: Pick<Settings, "providerSetupComplete"> =
    providerSetupComplete === true ? { providerSetupComplete } : {};
  if (theme === undefined || isTheme(theme)) {
    return {
      path,
      settings: { ...setup, theme: theme ?? DEFAULT_SETTINGS.theme },
    };
  }
  return {
    path,
    problem: `unknown theme ${JSON.stringify(theme)} in ${path}; using ${DEFAULT_SETTINGS.theme}`,
    settings: { ...setup, ...DEFAULT_SETTINGS },
  };
}

export function saveSettings(
  path: string,
  changes: Partial<Settings>
): Settings {
  const parsed = parse(path);
  if (parsed.kind === "invalid") {
    throw new Error(`${parsed.problem}; fix or remove it to save settings`);
  }
  if (changes.theme !== undefined && !isTheme(changes.theme)) {
    throw new Error(`unknown theme ${JSON.stringify(changes.theme)}`);
  }
  const current = parsed.kind === "read" ? parsed.value : {};
  const next = { ...current, ...changes };
  writeJson(path, next);
  return loadSettings(path).settings;
}
