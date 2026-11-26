import { resolve } from "node:path";
import { defineCommand } from "~/cli/command";
import { UsageError } from "~/cli/errors";
import { createStarter } from "~/workspace/create";
import {
  DEFAULT_STARTER,
  STARTERS,
  type StarterId,
} from "~/workspace/templates";

const STARTER_IDS = STARTERS.map((starter) => starter.id);
const STARTER_LIST = `${STARTER_IDS.slice(0, -1).join(", ")}, or ${STARTER_IDS.at(-1)}`;

function isStarter(id: string): id is StarterId {
  return STARTER_IDS.some((starter) => starter === id);
}

export const initCommand = defineCommand({
  group: "core",
  name: "init",
  needs: "none",
  parse([starter = DEFAULT_STARTER, ...rest]: readonly string[]): {
    readonly starter: StarterId;
  } {
    if (rest.length > 0 || !isStarter(starter)) {
      throw new UsageError(`init takes one starter: ${STARTER_LIST}`);
    }
    return { starter };
  },
  async run(ctx, args) {
    const starter = STARTERS.find((item) => item.id === args.starter);
    if (!starter) {
      throw new Error(`no starter "${args.starter}"`);
    }
    const file = await createStarter(resolve(ctx.flags.config), {
      instructions: "",
      name: starter.name,
      template: starter.id,
    });
    ctx.output({ file, starter: starter.id }, () => `Created ${file}`);
  },
  summary: `create a starter module (${STARTER_IDS.join(" | ")})`,
  usage: "init [starter]",
});
