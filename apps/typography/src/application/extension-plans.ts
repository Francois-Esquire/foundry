/** The script extension plans a command can name. One so far. */
import { DEVANAGARI_SUBSET } from "~/generation/script-extension/devanagari-subset";
import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";

export const EXTENSION_PLANS: Readonly<Record<string, ScriptExtensionPlan>> = {
  "devanagari-subset": DEVANAGARI_SUBSET,
};
