import type { Camera, Object3D, Scene } from "three";
import { uniform } from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";
import type {
  RenderQuality,
  RenderSettings,
  RenderStage,
} from "../../settings/chart-settings";

/**
 * What a stage of the pass graph is: a module in `stages.ts`'s ordered list,
 * as a layer is in `marks/layers.ts`. The composer (`scene/pipeline.ts`)
 * walks the list, loads what the settings need, and applies each stage in
 * order to one frame.
 */

export type ColorNode = Node<"vec4">;

/** A tier of the graph: every quality but off, which draws the scene directly. */
export type Tier = Exclude<RenderQuality, "off">;

/** A stage's id is also its view in the rendering sheet; `depth` is the composer's own view. */
export type StageId = Exclude<RenderStage, "depth">;

export const tiers: readonly Tier[] = ["low", "medium", "high"];

/**
 * Quality tiers trade resolution and filtering for speed. Everything else in
 * the graph is a per-setting toggle, so a tier never hides a control.
 */
export const qualityTiers = {
  high: {
    aoResolution: 1,
    aoSamples: 16,
    bloomResolution: 1,
    denoise: true,
    giSlices: 3,
    giSteps: 8,
  },
  low: {
    aoResolution: 0.5,
    aoSamples: 8,
    bloomResolution: 0.25,
    denoise: false,
    giSlices: 2,
    giSteps: 6,
  },
  medium: {
    aoResolution: 0.5,
    aoSamples: 12,
    bloomResolution: 0.5,
    denoise: true,
    giSlices: 2,
    giSteps: 6,
  },
} as const;

type QualityTable = (typeof qualityTiers)[Tier];

/** The uniforms the settings drive, shared by every stage and set by the composer's `configure`. */
export function createPipelineUniforms() {
  return {
    aoIntensity: uniform(1),
    aoRadius: uniform(1),
    aoThickness: uniform(2),
    bloomRadius: uniform(0),
    bloomStrength: uniform(0),
    bloomThreshold: uniform(1),
    exposure: uniform(1),
    giIntensity: uniform(1),
    saturation: uniform(1),
    vibrance: uniform(0),
  };
}

type PipelineUniforms = ReturnType<typeof createPipelineUniforms>;

/** What a stage may ask about the device before it is built. */
export interface StageContext {
  /** Screen-space GI needs a perspective camera; the chart's top-down camera cannot use it. */
  perspective: boolean;
}

interface Disposable {
  dispose?: () => void;
}

/** One frame of the graph as the stages pass it along, with what they share. */
export interface StageFrame {
  camera: Camera;
  /** The image so far: a stage reads it and leaves its result here. */
  color: ColorNode;
  depth: TextureNode;
  /** The nodes a stage made that own render targets, released with the graph. */
  nodes: Disposable[];
  /**
   * Normals come from depth. A normal target would also collect translucent
   * props (light shafts, the flat marks) and make them occlude the surface
   * beneath; depth already ignores them because they never write it.
   */
  normal: null;
  quality: QualityTable;
  /** The scene the frame draws, for a stage that renders it again on its own terms. */
  scene: Scene;
  /**
   * The objects the reader has selected, as the composer refills the one
   * array before each render; a stage that outlines them keeps the array,
   * so a change of selection never rebuilds the graph.
   */
  selection: Object3D[];
  settings: RenderSettings;
  /** A scene-pass attachment a stage asked for through `targets`. */
  target: (name: string) => ColorNode;
  tier: Tier;
  uniforms: PipelineUniforms;
}

/**
 * A stage of the pass graph. `load` is the stage's dynamic import, so the
 * chart's first paint never waits for a stage; `apply` adds the stage to the
 * graph, reading and replacing `frame.color`, and returns the stage's own
 * output, shown in place of the finished image when the sheet's "Show
 * stage" names the stage. Methods, not properties, so a stage with typed
 * inputs sits in the registry's list.
 */
export interface Stage<Inputs = unknown> {
  apply(frame: StageFrame, inputs: Inputs): ColorNode;
  id: StageId;
  label: string;
  load(): Promise<Inputs>;
  needs(settings: RenderSettings, tier: Tier, context: StageContext): boolean;
  /** Attachments the scene pass must render beside its output and depth, for the stage to read. */
  targets?: Record<string, Node>;
}
