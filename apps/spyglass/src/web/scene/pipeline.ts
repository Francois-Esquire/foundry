import type { Camera, Object3D, Scene } from "three";
import { mrt, output, pass, vec3, vec4 } from "three/tsl";
import { type Node, type Renderer, RenderPipeline } from "three/webgpu";
import type { RenderQuality, RenderSettings } from "../settings/chart-settings";
import { occlusionReach, occlusionStrength } from "./stages/occlusion";
import {
  type ColorNode,
  createPipelineUniforms,
  qualityTiers,
  type Stage,
  type StageContext,
  type StageFrame,
  type StageId,
  type Tier,
  tiers,
} from "./stages/stage";
import { stages as registry } from "./stages/stages";

/** What the viewer is actually drawing with, for the Chart panel readout. */
export interface RenderStatus {
  /** True once frames ran over budget and the tier stepped down on its own. */
  adapted: boolean;
  backend: "webgpu" | "webgl";
  /** Why the graph stopped, when it failed to build or render. */
  failure: string | null;
  /** Smoothed GPU time per frame in milliseconds, when the device reports it. */
  frameMs: number | null;
  /** Screen-space GI needs a perspective camera; the chart's top-down camera cannot use it. */
  globalIlluminationAvailable: boolean;
  /** False when the quality is off or the pass graph failed and the scene draws directly. */
  postProcessing: boolean;
  /** The tier in use, which is lower than the setting after adapting. */
  quality: RenderQuality;
}

/** One stage of the registry as the graph stands: built into it, or not. */
export interface StageStatus {
  enabled: boolean;
  id: StageId;
  label: string;
}

export interface RenderPipelineOptions {
  camera: Camera;
  onStatus?: (status: RenderStatus) => void;
  renderer: Renderer;
  scene: Scene;
  /**
   * The objects the reader has selected, read before each render for the
   * stages that draw the selection; a change of selection moves nothing but
   * the frame's `selection` array, never the graph.
   */
  selectedObjects?: () => Object3D[];
  /** The stages to compose, in order; the registry unless a test passes its own. */
  stages?: readonly Stage[];
  /**
   * World units per screen pixel at the point of interest. Occlusion reach is
   * a screen size so the look holds at every zoom.
   */
  unitsPerPixel?: () => number;
}

interface Disposable {
  dispose?: () => void;
}

/** A frame slower than this, sustained, steps the tier down. */
const frameBudgetMs = 34;
/** Frames measured before the tier may step down. */
const framesBeforeStepping = 24;

/** Each stage's module, loaded once per page; a failed load is tried again. */
const loaded = new WeakMap<Stage, Promise<unknown>>();

function loadStage(stage: Stage): Promise<unknown> {
  let loading = loaded.get(stage);
  if (!loading) {
    loading = stage.load();
    loaded.set(stage, loading);
    loading.catch(() => loaded.delete(stage));
  }
  return loading;
}

/** The depth as a view: banded, so the relief reads. */
const depthView = (depth: StageFrame["depth"]): ColorNode =>
  vec4(vec3(depth.r.mul(40).fract()), 1);

/**
 * The composer of the pass graph: one graph for every spyglass view, built
 * by walking the stage registry (`stages/stages.ts`) in order. A stage is
 * built when its `needs` says so for the settings and the tier; the display
 * stage, last, finishes the image. When quality is off, or the graph cannot
 * compile on this device, the scene draws directly as it always has.
 */
export function createRenderPipeline(options: RenderPipelineOptions) {
  const { renderer, scene, camera, onStatus } = options;
  const stages = options.stages ?? registry;
  const unitsPerPixel = options.unitsPerPixel ?? (() => 1);
  const selectedObjects = options.selectedObjects ?? (() => []);
  /** One array for the graph's life, refilled before each render; a stage keeps it rather than its contents. */
  const selection: Object3D[] = [];
  const context: StageContext = {
    perspective:
      (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera ===
      true,
  };
  const backend: RenderStatus["backend"] =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
      ? "webgpu"
      : "webgl";
  const uniforms = createPipelineUniforms();
  let pipeline: RenderPipeline | null = null;
  let nodes: Disposable[] = [];
  let built = new Set<StageId>();
  let signature = "";
  let failed = false;
  let failure: string | null = null;
  let disposed = false;
  let current: RenderSettings | null = null;
  let building: Promise<void> = Promise.resolve();
  let generation = 0;
  // Adaptive quality: the tier in use never exceeds the setting, and steps
  // down when the device reports frames over budget.
  let cap: Tier | null = null;
  let frameMs: number | null = null;
  let frames = 0;
  let timing = typeof renderer.resolveTimestampsAsync === "function";
  let resolving = false;
  /** The frame's timestamp query in flight, which the renderer must not be disposed under. */
  let resolution: Promise<void> = Promise.resolve();

  const effectiveQuality = (settings: RenderSettings): RenderQuality => {
    if (settings.quality === "off" || !cap) {
      return settings.quality;
    }
    const index = Math.min(tiers.indexOf(settings.quality), tiers.indexOf(cap));
    return tiers[index] ?? settings.quality;
  };
  const needed = (settings: RenderSettings, tier: Tier): Stage[] =>
    stages.filter((stage) => stage.needs(settings, tier, context));
  /** What the graph is made of: a change rebuilds it, where a slider only moves a uniform. */
  const structure = (settings: RenderSettings, tier: Tier) =>
    [
      tier,
      ...needed(settings, tier).map((stage) => stage.id),
      settings.stage,
      settings.toneMapping,
    ].join("|");
  const release = () => {
    for (const node of nodes) {
      node.dispose?.();
    }
    nodes = [];
    built = new Set();
    pipeline?.dispose();
    pipeline = null;
  };
  const status = (): RenderStatus => {
    const postProcessing = pipeline !== null && !failed;
    return {
      adapted: cap !== null,
      backend,
      failure,
      // Only pipeline frames are timed; the direct draw has no readout.
      frameMs: postProcessing ? frameMs : null,
      globalIlluminationAvailable: context.perspective,
      postProcessing,
      quality: current ? effectiveQuality(current) : "off",
    };
  };

  /** Walks the active stages in order over one frame, then takes the view the settings name, or the finished image. */
  const build = (
    settings: RenderSettings,
    tier: Tier,
    active: readonly Stage[],
    inputs: readonly unknown[]
  ) => {
    const scenePass = pass(scene, camera, { samples: 0 });
    nodes.push(scenePass);
    const targets = active.flatMap((stage) =>
      Object.entries(stage.targets ?? {})
    );
    if (targets.length) {
      // Output stays in attachment 0, where the background clear lands, so
      // the targets are assigned in order rather than declared as a literal.
      const attachments: Record<string, Node> = {};
      attachments.output = output;
      for (const [name, node] of targets) {
        attachments[name] = node;
      }
      scenePass.setMRT(mrt(attachments));
    }
    const frame: StageFrame = {
      camera,
      color: scenePass.getTextureNode("output"),
      depth: scenePass.getTextureNode("depth"),
      nodes,
      quality: qualityTiers[tier],
      scene,
      selection,
      settings,
      target: (name) => scenePass.getTextureNode(name),
      tier,
      uniforms,
    };
    let view: ColorNode | null =
      settings.stage === "depth" ? depthView(frame.depth) : null;
    for (const [index, stage] of active.entries()) {
      const own = stage.apply(frame, inputs[index]);
      if (settings.stage === stage.id) {
        view = own;
      }
    }
    const next = new RenderPipeline(renderer);
    next.outputColorTransform = false;
    next.outputNode = view ?? frame.color;
    pipeline = next;
    built = new Set(active.map((stage) => stage.id));
  };

  const fail = (error: unknown) => {
    failed = true;
    failure = error instanceof Error ? error.message : String(error);
  };

  const rebuild = (settings: RenderSettings, tier: Tier) => {
    generation += 1;
    const mine = generation;
    const active = needed(settings, tier);
    building = Promise.all(active.map(loadStage)).then(
      (inputs) => {
        if (mine !== generation || disposed) {
          return;
        }
        try {
          build(settings, tier, active, inputs);
        } catch (error) {
          fail(error);
        }
        onStatus?.(status());
      },
      (error: unknown) => {
        if (mine === generation && !disposed) {
          fail(error);
          onStatus?.(status());
        }
      }
    );
  };

  const configure = (settings: RenderSettings) => {
    if (current && settings.quality !== current.quality) {
      // Choosing a tier is an explicit decision; it clears the adaptive cap.
      cap = null;
    }
    current = settings;
    occlusionStrength(uniforms, settings);
    uniforms.bloomRadius.value = settings.bloomRadius;
    uniforms.bloomStrength.value = settings.bloomStrength;
    uniforms.bloomThreshold.value = settings.bloomThreshold;
    uniforms.exposure.value = settings.exposure;
    uniforms.giIntensity.value = settings.giIntensity;
    uniforms.saturation.value = settings.saturation;
    uniforms.vibrance.value = settings.vibrance;
    const quality = effectiveQuality(settings);
    const next = quality === "off" ? "" : structure(settings, quality);
    if (next === signature) {
      return;
    }
    signature = next;
    failed = false;
    failure = null;
    frames = 0;
    release();
    if (quality === "off") {
      generation += 1;
      onStatus?.(status());
      return;
    }
    rebuild(settings, quality);
  };

  const stepDown = () => {
    if (!current) {
      return;
    }
    const index = tiers.indexOf(effectiveQuality(current) as Tier);
    if (index <= 0) {
      return;
    }
    cap = tiers[index - 1] ?? null;
    configure(current);
  };

  const resolve = async () => {
    try {
      await renderer.resolveTimestampsAsync("render");
      const ms = renderer.info.render.timestamp;
      if (ms > 0) {
        frameMs = frameMs === null ? ms : frameMs * 0.8 + ms * 0.2;
        frames += 1;
        if (frames >= framesBeforeStepping && frameMs > frameBudgetMs) {
          stepDown();
        }
      }
    } catch {
      // Without timestamp queries the tier stays where the user set it.
      timing = false;
    } finally {
      resolving = false;
    }
  };
  const measure = () => {
    if (!timing || resolving) {
      return;
    }
    resolving = true;
    resolution = resolve();
  };

  return {
    configure,
    dispose() {
      disposed = true;
      generation += 1;
      release();
    },
    /** Resolves once the current graph is built; for tests and first paint. */
    ready: () => building,
    render() {
      if (pipeline && !failed) {
        if (current) {
          occlusionReach(uniforms, current, unitsPerPixel());
        }
        selection.length = 0;
        selection.push(...selectedObjects());
        try {
          pipeline.render();
          measure();
          return;
        } catch (error) {
          // A stage the device cannot compile must not blank the chart.
          fail(error);
          release();
          onStatus?.(status());
        }
      }
      renderer.render(scene, camera);
      measure();
    },
    /** Resolves once no timestamp query is in flight, so the renderer may be disposed without aborting one. */
    settled: () => resolution,
    /** Every stage of the registry, in order, and whether the graph as built holds it. GPU time is known for the frame as a whole (`status().frameMs`), never per stage. */
    stages: (): StageStatus[] =>
      stages.map((stage) => ({
        enabled: built.has(stage.id) && pipeline !== null && !failed,
        id: stage.id,
        label: stage.label,
      })),
    status,
  };
}
