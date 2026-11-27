import { claudeCode } from "~/lib/providers/claude-code";
import { codex } from "~/lib/providers/codex";
import { echoInstance } from "./echo";

for (const plugin of [claudeCode, codex]) {
  const { create } = plugin;
  plugin.create = (setup) => {
    const created = create(setup);
    return {
      ...created,
      provider: echoInstance(created.provider, () => undefined),
    };
  };
}
