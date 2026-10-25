import type { RenderStage } from "../../settings/chart-settings";
import { bloom } from "./bloom";
import { display } from "./display";
import { indirect } from "./indirect";
import { occlusion } from "./occlusion";
import { outline } from "./outline";
import type { Stage } from "./stage";

/**
 * The pass graph's stages in the order they apply to the frame: scene →
 * occlusion → indirect light → the selection glow → bloom, which lifts it →
 * the display stage, which finishes the image and is always built. Each
 * reads the same depth, with its normal read from it (`stage.ts`), so a
 * stage such as a cloud layer plugs into the same inputs.
 */
export const stages: readonly Stage[] = [
  occlusion,
  indirect,
  outline,
  bloom,
  display,
];

/**
 * The views the rendering sheet may show in place of the finished image:
 * each stage's own output, by the stage's id and label, and the depth. A
 * stage added to the list adds its view.
 */
export const renderStages = Object.fromEntries([
  ...stages.map((stage) => [stage.id, { label: stage.label }] as const),
  ["depth", { label: "Depth" }] as const,
]) as Record<RenderStage, { label: string }>;
