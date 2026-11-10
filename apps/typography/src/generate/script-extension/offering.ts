/**
 * The script extension on offer: a plan, and the recorded run whose sheets
 * were drawn for it. The recorded run is the only source, because the
 * prompts for a plan's sheets are kept with the run that used them.
 */
import { DEVANAGARI_SUBSET } from "~/generation/script-extension/devanagari-subset";
import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";

export interface ExtensionOffering {
  readonly plan: ScriptExtensionPlan;
  /** The directory the recorded run is served from, under the recorded runs. */
  readonly recordedRun: string;
}

export const DEVANAGARI_OFFERING: ExtensionOffering = {
  plan: DEVANAGARI_SUBSET,
  recordedRun: "2026-11-10-devanagari-subset",
};
