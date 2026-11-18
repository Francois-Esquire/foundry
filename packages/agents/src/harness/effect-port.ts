import type { ToolEffectPort } from "./types";

export const directToolEffectPort: ToolEffectPort = {
  execute(_call, effect) {
    return effect();
  },
};
