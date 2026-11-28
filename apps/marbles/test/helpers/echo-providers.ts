import { claudeCode } from "~/providers/claude-code";
import { codex } from "~/providers/codex";
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
