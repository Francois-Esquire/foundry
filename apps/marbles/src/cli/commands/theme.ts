import { defineCommand } from "~/cli/command";
import { UsageError } from "~/cli/errors";
import { loadSettings, saveSettings, settingsPath } from "~/cli/settings";
import { isTheme, THEME_NAMES, type ThemeName } from "~/model/settings";

type ThemeArgs =
  | { readonly action: "get" | "list" }
  | { readonly action: "set"; readonly theme: ThemeName };

export const themeCommand = defineCommand({
  group: "system",
  name: "theme",
  needs: "none",
  parse([name, ...rest]: readonly string[]): ThemeArgs {
    if (rest.length > 0) {
      throw new UsageError("theme takes list, or one theme name to save it");
    }
    if (name === undefined) {
      return { action: "get" };
    }
    if (name === "list") {
      return { action: "list" };
    }
    if (!isTheme(name)) {
      throw new UsageError(
        `unknown theme "${name}"; marbles theme list shows them`
      );
    }
    return { action: "set", theme: name };
  },
  run(ctx, args) {
    if (args.action === "list") {
      ctx.output({ themes: THEME_NAMES }, ({ themes }) => themes.join("\n"));
      return;
    }
    const path = settingsPath(ctx.flags.state);
    if (args.action === "set") {
      try {
        const saved = saveSettings(path, { theme: args.theme }).theme;
        ctx.output({ theme: saved }, ({ theme }) => theme);
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
    ctx.output({ theme: loaded.settings.theme }, ({ theme }) => theme);
  },
  summary: "print, list, or save the terminal theme",
  usage: [
    { command: "theme", summary: "print the saved terminal theme" },
    { command: "theme list", summary: "list terminal themes" },
    { command: "theme <name>", summary: "save a theme for every workspace" },
  ],
});
