import type { ToolEffectPort } from "./types";

/**
 * The harness's own default {@link ToolEffectPort} (design: "Effect
 * boundary") — runs the effect in-process with no durability, no host
 * involved, and no idempotency handling of its own. Lets lightweight
 * direct/CLI use of {@link AgentHarness} keep working without a workflow host.
 * A host can inject its own run-aware adapter in place of this one.
 */
export const directToolEffectPort: ToolEffectPort = {
  execute(_call, effect) {
    return effect();
  },
};
