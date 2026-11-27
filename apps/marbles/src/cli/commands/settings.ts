import { defineCommand } from "~/cli/command";
import { UsageError } from "~/cli/errors";
import { loadSettings, saveSettings, settingsPath } from "~/cli/settings";
import { isTheme, THEME_NAMES, type ThemeName } from "~/model/settings";

const SETTING_KEYS = ["theme"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

type SettingsArgs =
  | { readonly action: "show" | "themes" }
  | { readonly action: "get"; readonly key: SettingKey }
  | {
      readonly action: "set";
      readonly key: "theme";
      readonly value: ThemeName;
    };

function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

function checkedKey(action: string, key: string | undefined): SettingKey {
  if (key === undefined) {
    throw new UsageError(
      `settings ${action} takes a key (${SETTING_KEYS.join(", ")})`
    );
  }
  if (!isSettingKey(key)) {
    throw new UsageError(
      `unknown setting "${key}"; valid keys: ${SETTING_KEYS.join(", ")}`
    );
  }
  return key;
}

export const settingsCommand = defineCommand({
  group: "system",
  name: "settings",
  needs: "none",
  parse(positionals: readonly string[]): SettingsArgs {
    const [action, ...rest] = positionals;
    if (action === undefined || action === "list") {
      if (rest.length > 0) {
        throw new UsageError("settings takes no extra arguments");
      }
      return { action: "show" };
    }
    if (action === "themes") {
      if (rest.length > 0) {
        throw new UsageError("settings themes takes no arguments");
      }
      return { action: "themes" };
    }
    if (action === "get") {
      const [key, ...extra] = rest;
      if (extra.length > 0) {
        throw new UsageError("settings get takes one key");
      }
      return { action: "get", key: checkedKey("get", key) };
    }
    if (action === "set") {
      const [rawKey, value, ...extra] = rest;
      const key = checkedKey("set", rawKey);
      if (value === undefined || extra.length > 0) {
        throw new UsageError(`settings set ${key} takes one value`);
      }
      if (!isTheme(value)) {
        throw new UsageError(
          `unknown theme "${value}"; marbles settings themes lists them`
        );
      }
      return { action: "set", key, value };
    }
    throw new UsageError(
      "settings takes get <key>, set <key> <value>, or themes"
    );
  },
  run(ctx, args) {
    if (args.action === "themes") {
      ctx.output({ themes: THEME_NAMES }, ({ themes }) => themes.join("\n"));
      return;
    }
    const path = settingsPath(ctx.flags.state);
    if (args.action === "set") {
      try {
        const saved = saveSettings(path, { theme: args.value }).theme;
        ctx.output({ key: args.key, value: saved }, ({ value }) => value);
      } catch (error) {
        throw new UsageError(
          error instanceof Error ? error.message : String(error),
          { cause: error }
        );
      }
      return;
    }
    const loaded = loadSettings(path);
    if (loaded.problem) {
      ctx.io.diagnose(`${loaded.problem} (${loaded.path})`);
    }
    if (args.action === "get") {
      const value = loaded.settings[args.key];
      ctx.output({ key: args.key, value }, (entry) => entry.value);
      return;
    }
    ctx.output(loaded.settings, (settings) => `theme: ${settings.theme}`);
  },
  summary: "read or save Marbles settings",
  usage: [
    { command: "settings", summary: "print saved settings" },
    { command: "settings get <key>", summary: "print one setting (theme)" },
    {
      command: "settings set <key> <value>",
      summary: "save a setting for every workspace (e.g. theme)",
    },
    { command: "settings themes", summary: "list available terminal themes" },
  ],
});
