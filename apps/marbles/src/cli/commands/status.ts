import { resolve } from "node:path";
import { defineCommand, noPositionals } from "~/cli/command";
import { loadSettings, settingsPath } from "~/cli/settings";
import { statusText } from "~/cli/status/text";
import { readStatus } from "~/status/model";

export const statusCommand = defineCommand({
  group: "core",
  name: "status",
  needs: "workspace",
  parse: noPositionals("status"),
  async run(ctx) {
    const report = await readStatus(resolve(ctx.flags.state));
    if (ctx.interactive && !ctx.flags.json) {
      const [{ showStatus }, { applyTheme }] = await Promise.all([
        import("~/tui/status/view"),
        import("~/tui/theme"),
      ]);
      applyTheme(loadSettings(settingsPath(ctx.flags.state)).settings.theme);
      await showStatus({ here: ctx.workspace.workspace.id, report });
      return;
    }
    ctx.output(report, (value) =>
      statusText(value, ctx.workspace.workspace.id)
    );
  },
  summary: "the Marbles process and every workspace it has run",
  usage: "status",
});
