import type { Camera, Scene, Texture } from "three";
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  ReinhardToneMapping,
  SRGBColorSpace,
} from "three";
import {
  diffuseColor,
  grayscale,
  mix,
  mrt,
  output,
  pass,
  renderOutput,
  texture as sampleTexture,
  saturation,
  screenUV,
  uniform,
  vec3,
  vec4,
  vibrance,
} from "three/tsl";
import { type Node, type Renderer, RenderPipeline } from "three/webgpu";
import type {
  chartFilters,
  RenderQuality,
  RenderSettings,
} from "../chart-settings";

type Filter = keyof typeof chartFilters;
type ColorNode = Node<"vec4">;
type Tier = Exclude<RenderQuality, "off">;

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

export interface RenderPipelineOptions {
  camera: Camera;
  filter: (settings: RenderSettings) => Filter;
  /**
   * Depth spread, in world units, beyond which occlusion samples are treated
   * as separate surfaces. Defaults to twice the reach, which suits the chart;
   * a perspective scene with a far floor at a grazing angle needs more.
   */
  occlusionThickness?: number;
  onStatus?: (status: RenderStatus) => void;
  overlay?: Texture;
  renderer: Renderer;
  scene: Scene;
  /**
   * World units per screen pixel at the point of interest. Occlusion reach is
   * a screen size so the look holds at every zoom.
   */
  unitsPerPixel?: () => number;
}

interface Disposable {
  dispose?: () => void;
}

/** Stage modules load on demand so the chart's first paint does not wait for them. */
const stageLoaders = {
  ao: () => import("three/addons/tsl/display/GTAONode.js"),
  bloom: () => import("three/addons/tsl/display/BloomNode.js"),
  denoise: () => import("three/addons/tsl/display/DenoiseNode.js"),
  sepia: () => import("three/addons/tsl/display/Sepia.js"),
  ssgi: () => import("three/addons/tsl/display/SSGINode.js"),
};

type StageName = keyof typeof stageLoaders;
type Stages = {
  [K in StageName]?: Awaited<ReturnType<(typeof stageLoaders)[K]>>;
};

const loaded: Stages = {};

async function loadStages(names: StageName[]): Promise<Stages> {
  await Promise.all(
    names.map(async (name) => {
      if (!loaded[name]) {
        (loaded as Record<StageName, unknown>)[name] =
          await stageLoaders[name]();
      }
    })
  );
  return loaded;
}

/** Occlusion strength 1 maps to this exponent on the raw GTAO term. */
const aoExponent = 3;

/** A frame slower than this, sustained, steps the tier down. */
const frameBudgetMs = 34;
/** Frames measured before the tier may step down. */
const framesBeforeStepping = 24;
const tiers: Tier[] = ["low", "medium", "high"];

const toneMappingModes = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  none: NoToneMapping,
  reinhard: ReinhardToneMapping,
} as const;

/**
 * Quality tiers trade resolution and filtering for speed. Everything else in
 * the graph is a per-setting toggle, so a tier never hides a control.
 */
const qualityTiers = {
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

/** Mirrors the former CSS filters so each preset keeps its character. */
function createGrades(stages: Stages) {
  const sepiaTone = (rgb: Node<"vec3">) =>
    stages.sepia ? (stages.sepia.sepia(rgb) as Node<"vec3">) : rgb;
  const grades: Record<Filter, (rgb: Node<"vec3">) => Node<"vec3">> = {
    faded: (rgb) =>
      mix(saturation(rgb, 0.45), sepiaTone(saturation(rgb, 0.45)), 0.18),
    graphite: (rgb) => vec3(grayscale(rgb)),
    original: (rgb) => rgb,
    treasure: (rgb) =>
      saturation(mix(grayscale(rgb), sepiaTone(grayscale(rgb)), 0.65), 0.85),
  };
  return grades;
}

interface Frame {
  color: ColorNode;
  depth: ReturnType<ReturnType<typeof pass>["getTextureNode"]>;
  /** A stage view replaces the graded image with one stage's output. */
  view: ColorNode | null;
}

/**
 * One pass graph for every atlas view: scene → overlay → occlusion → indirect
 * light → bloom → exposure and tone mapping → grade. Each stage is optional
 * and reads the same depth and normal targets, so a future stage such as a
 * cloud layer plugs into the same inputs. When quality is off, or the graph
 * cannot compile on this device, the scene draws directly as it always has.
 */
export function createRenderPipeline(options: RenderPipelineOptions) {
  const { renderer, scene, camera, filter, overlay, onStatus } = options;
  const unitsPerPixel = options.unitsPerPixel ?? (() => 1);
  const perspective =
    (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true;
  const backend: RenderStatus["backend"] =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
      ? "webgpu"
      : "webgl";
  const uniforms = {
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
  // Normals come from depth. A normal target would also collect translucent
  // props (light shafts, the ink plane) and make them occlude the surface
  // beneath; depth already ignores them because they never write it.
  const normal = null as never;
  let pipeline: RenderPipeline | null = null;
  let stages: Disposable[] = [];
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

  const effectiveQuality = (settings: RenderSettings): RenderQuality => {
    if (settings.quality === "off" || !cap) {
      return settings.quality;
    }
    const index = Math.min(tiers.indexOf(settings.quality), tiers.indexOf(cap));
    return tiers[index] ?? settings.quality;
  };
  const structure = (settings: RenderSettings, quality: RenderQuality) =>
    [
      quality,
      settings.ambientOcclusion,
      settings.bloom,
      settings.globalIllumination && perspective,
      settings.stage,
      settings.toneMapping,
      filter(settings),
    ].join("|");
  const release = () => {
    for (const stage of stages) {
      stage.dispose?.();
    }
    stages = [];
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
      globalIlluminationAvailable: perspective,
      postProcessing,
      quality: current ? effectiveQuality(current) : "off",
    };
  };
  const neededStages = (settings: RenderSettings, tier: Tier): StageName[] => {
    const names: StageName[] = [];
    if (settings.ambientOcclusion) {
      names.push("ao");
      if (qualityTiers[tier].denoise) {
        names.push("denoise");
      }
    }
    if (settings.bloom) {
      names.push("bloom");
    }
    if (settings.globalIllumination && perspective) {
      names.push("ssgi");
    }
    const grade = filter(settings);
    if (grade === "faded" || grade === "treasure") {
      names.push("sepia");
    }
    return names;
  };

  const addOcclusion = (
    frame: Frame,
    settings: RenderSettings,
    tier: Tier,
    modules: Stages
  ) => {
    if (!(settings.ambientOcclusion && modules.ao)) {
      return;
    }
    const quality = qualityTiers[tier];
    const occlusion = modules.ao.ao(frame.depth, normal, camera);
    occlusion.resolutionScale = quality.aoResolution;
    occlusion.samples.value = quality.aoSamples;
    occlusion.radius = uniforms.aoRadius;
    occlusion.thickness = uniforms.aoThickness;
    occlusion.distanceFallOff.value = 0.4;
    // Relief on the chart is gentle, so strength is an exponent on the
    // occlusion term rather than a linear mix; it deepens valleys and the
    // foot of buildings without clipping.
    occlusion.scale = uniforms.aoIntensity;
    stages.push(occlusion);
    let shade: ColorNode = occlusion.getTextureNode();
    if (quality.denoise && modules.denoise) {
      const smoothed = modules.denoise.denoise(
        shade,
        frame.depth,
        normal,
        camera
      );
      stages.push(smoothed);
      // The denoiser's declaration omits its vec4 output type.
      shade = smoothed as unknown as ColorNode;
    }
    frame.color = vec4(frame.color.rgb.mul(shade.r), frame.color.a);
    if (settings.stage === "occlusion") {
      frame.view = vec4(shade.rrr, 1);
    }
  };

  const addIndirect = (
    frame: Frame,
    albedo: ColorNode,
    settings: RenderSettings,
    tier: Tier,
    modules: Stages
  ) => {
    if (!modules.ssgi) {
      return;
    }
    const quality = qualityTiers[tier];
    const indirect = modules.ssgi.ssgi(
      frame.color,
      frame.depth,
      normal,
      camera as never
    );
    indirect.useTemporalFiltering = false;
    indirect.sliceCount.value = quality.giSlices;
    indirect.stepCount.value = quality.giSteps;
    stages.push(indirect);
    const bounce = albedo.rgb
      .mul(indirect.getGINode().rgb)
      .mul(uniforms.giIntensity);
    frame.color = vec4(
      frame.color.rgb.mul(indirect.getAONode().r).add(bounce),
      frame.color.a
    );
    if (settings.stage === "indirect") {
      frame.view = vec4(bounce, 1);
    }
  };

  const addBloom = (
    frame: Frame,
    settings: RenderSettings,
    tier: Tier,
    modules: Stages
  ) => {
    if (!(settings.bloom && modules.bloom)) {
      return;
    }
    const glow = modules.bloom.bloom(
      frame.color,
      uniforms.bloomStrength,
      uniforms.bloomRadius,
      uniforms.bloomThreshold
    );
    glow.setResolutionScale(qualityTiers[tier].bloomResolution);
    stages.push(glow);
    frame.color = vec4(frame.color.rgb.add(glow.rgb), frame.color.a);
    if (settings.stage === "bloom") {
      frame.view = vec4(glow.rgb, 1);
    }
  };

  const build = (settings: RenderSettings, tier: Tier, modules: Stages) => {
    const useGi = settings.globalIllumination && perspective;
    const scenePass = pass(scene, camera, { samples: 0 });
    stages.push(scenePass);
    if (useGi) {
      // Output stays in attachment 0, where the background clear lands, so
      // the targets are assigned in order rather than declared as a literal.
      const targets: Record<string, Node> = {};
      targets.output = output;
      targets.diffuseColor = diffuseColor;
      scenePass.setMRT(mrt(targets));
    }
    const frame: Frame = {
      color: scenePass.getTextureNode("output"),
      depth: scenePass.getTextureNode("depth"),
      view: null,
    };
    if (settings.stage === "depth") {
      frame.view = vec4(vec3(frame.depth.r.mul(40).fract()), 1);
    }
    if (overlay) {
      // Coastlight and wind strokes join the frame before occlusion and bloom
      // so they glow and grade with everything else.
      const layer = sampleTexture(overlay, screenUV.flipY());
      frame.color = vec4(
        mix(frame.color.rgb, layer.rgb, layer.a),
        frame.color.a
      );
    }
    addOcclusion(frame, settings, tier, modules);
    if (useGi) {
      const albedo = scenePass.getTextureNode("diffuseColor");
      addIndirect(frame, albedo, settings, tier, modules);
    }
    addBloom(frame, settings, tier, modules);
    const exposed = vec4(frame.color.rgb.mul(uniforms.exposure), frame.color.a);
    const display = renderOutput(
      exposed,
      toneMappingModes[settings.toneMapping],
      SRGBColorSpace
    );
    const adjusted = vibrance(
      saturation(display.rgb, uniforms.saturation),
      uniforms.vibrance
    );
    const graded = vec4(
      createGrades(modules)[filter(settings)](adjusted),
      display.a
    );
    const next = new RenderPipeline(renderer);
    next.outputColorTransform = false;
    next.outputNode = frame.view ?? graded;
    pipeline = next;
  };

  const fail = (error: unknown) => {
    failed = true;
    failure = error instanceof Error ? error.message : String(error);
  };

  const rebuild = (settings: RenderSettings, tier: Tier) => {
    generation += 1;
    const mine = generation;
    building = loadStages(neededStages(settings, tier)).then(
      (modules) => {
        if (mine !== generation || disposed) {
          return;
        }
        try {
          build(settings, tier, modules);
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
    uniforms.aoIntensity.value = settings.aoIntensity * aoExponent;
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

  const measure = async () => {
    if (!timing || resolving) {
      return;
    }
    resolving = true;
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
          const radius = current.aoReach * unitsPerPixel();
          uniforms.aoRadius.value = radius;
          // The chart is viewed at a tilt, so samples along flat paper still
          // differ in view depth; thickness must exceed that spread.
          uniforms.aoThickness.value = options.occlusionThickness ?? radius * 2;
        }
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
    },
    status,
  };
}
