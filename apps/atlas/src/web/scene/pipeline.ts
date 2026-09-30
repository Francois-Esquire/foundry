import type { Camera, Scene, Texture } from "three";
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  ReinhardToneMapping,
  SRGBColorSpace,
} from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { sepia } from "three/addons/tsl/display/Sepia.js";
import { ssgi } from "three/addons/tsl/display/SSGINode.js";
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
import type { chartFilters, RenderSettings } from "../chart-settings";

type Filter = keyof typeof chartFilters;
type ColorNode = Node<"vec4">;

/** The sepia addon ships without an output type. */
const sepiaTone = (rgb: Node<"vec3">) => sepia(rgb) as Node<"vec3">;

/** What the viewer is actually drawing with, for the Chart panel readout. */
export interface RenderStatus {
  backend: "webgpu" | "webgl";
  /** Screen-space GI needs a perspective camera; the chart's top-down camera cannot use it. */
  globalIlluminationAvailable: boolean;
  /** False when the quality is off or the pass graph failed and the scene draws directly. */
  postProcessing: boolean;
}

interface Disposable {
  dispose?: () => void;
}

/** `?debug=ao` or `?debug=depth` shows a stage's output instead of the chart. */
const debugView = () =>
  typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("debug");

/** Occlusion strength 1 maps to this exponent on the raw GTAO term. */
const aoExponent = 3;

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

/**
 * One pass graph for every atlas view: scene → overlay → occlusion → indirect
 * light → bloom → exposure and tone mapping → grade. Each stage is optional
 * and reads the same depth and normal targets, so a future stage such as a
 * cloud layer plugs into the same inputs. When quality is off, or the graph
 * cannot compile on this device, the scene draws directly as it always has.
 */
export function createRenderPipeline(
  renderer: Renderer,
  scene: Scene,
  camera: Camera,
  filter: (settings: RenderSettings) => Filter,
  overlay?: Texture,
  onStatus?: (status: RenderStatus) => void
) {
  const perspective =
    (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true;
  const backend: RenderStatus["backend"] =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
      ? "webgpu"
      : "webgl";
  const uniforms = {
    aoIntensity: uniform(1),
    exposure: uniform(1),
    giIntensity: uniform(1),
    saturation: uniform(1),
    vibrance: uniform(0),
  };
  let pipeline: RenderPipeline | null = null;
  let stages: Disposable[] = [];
  let signature = "";
  let failed = false;
  const structure = (settings: RenderSettings) =>
    [
      settings.quality,
      settings.ambientOcclusion,
      settings.aoRadius,
      settings.bloom,
      settings.bloomRadius,
      settings.bloomStrength,
      settings.bloomThreshold,
      settings.globalIllumination && perspective,
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
  const status = (): RenderStatus => ({
    backend,
    globalIlluminationAvailable: perspective,
    postProcessing: pipeline !== null && !failed,
  });
  // Mirrors the former CSS filters so each preset keeps its character.
  const grades: Record<Filter, (rgb: Node<"vec3">) => Node<"vec3">> = {
    faded: (rgb) =>
      mix(saturation(rgb, 0.45), sepiaTone(saturation(rgb, 0.45)), 0.18),
    graphite: (rgb) => vec3(grayscale(rgb)),
    original: (rgb) => rgb,
    treasure: (rgb) =>
      saturation(mix(grayscale(rgb), sepiaTone(grayscale(rgb)), 0.65), 0.85),
  };
  const build = (settings: RenderSettings) => {
    const tier = qualityTiers[settings.quality as keyof typeof qualityTiers];
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
    const depth = scenePass.getTextureNode("depth");
    // Normals come from depth. A normal target would also collect translucent
    // props (light shafts, the ink plane) and make them occlude the surface
    // beneath; depth already ignores them because they never write it.
    const normal = null as never;
    let color: ColorNode = scenePass.getTextureNode("output");
    if (overlay) {
      // Coastlight and wind strokes join the frame before occlusion and bloom
      // so they glow and grade with everything else.
      const layer = sampleTexture(overlay, screenUV.flipY());
      color = vec4(mix(color.rgb, layer.rgb, layer.a), color.a);
    }
    if (settings.ambientOcclusion) {
      const occlusion = ao(depth, normal, camera);
      occlusion.resolutionScale = tier.aoResolution;
      occlusion.samples.value = tier.aoSamples;
      occlusion.radius.value = settings.aoRadius;
      // The chart is viewed at a tilt, so samples along flat paper still
      // differ in view depth; thickness must exceed that spread.
      occlusion.thickness.value = settings.aoRadius * 2;
      occlusion.distanceFallOff.value = 0.4;
      // Relief on the chart is gentle, so strength is an exponent on the
      // occlusion term rather than a linear mix; it deepens valleys and the
      // foot of buildings without clipping.
      occlusion.scale = uniforms.aoIntensity;
      stages.push(occlusion);
      let shade: ColorNode = occlusion.getTextureNode();
      if (tier.denoise) {
        const smoothed = denoise(shade, depth, normal, camera);
        stages.push(smoothed);
        // The denoiser's declaration omits its vec4 output type.
        shade = smoothed as unknown as ColorNode;
      }
      color = vec4(color.rgb.mul(shade.r), color.a);
      const debug = debugView();
      if (debug === "ao") {
        color = vec4(shade.rrr, 1);
      } else if (debug === "depth") {
        color = vec4(vec3(depth.r.mul(40).fract()), 1);
      }
    }
    if (useGi) {
      const indirect = ssgi(color, depth, normal, camera as never);
      indirect.useTemporalFiltering = false;
      indirect.sliceCount.value = tier.giSlices;
      indirect.stepCount.value = tier.giSteps;
      stages.push(indirect);
      const albedo = scenePass.getTextureNode("diffuseColor");
      const bounce = albedo.rgb
        .mul(indirect.getGINode().rgb)
        .mul(uniforms.giIntensity);
      color = vec4(color.rgb.mul(indirect.getAONode().r).add(bounce), color.a);
    }
    if (settings.bloom) {
      const glow = bloom(
        color,
        settings.bloomStrength,
        settings.bloomRadius,
        settings.bloomThreshold
      );
      glow.setResolutionScale(tier.bloomResolution);
      stages.push(glow);
      color = vec4(color.rgb.add(glow.rgb), color.a);
    }
    const exposed = vec4(color.rgb.mul(uniforms.exposure), color.a);
    const display = renderOutput(
      exposed,
      toneMappingModes[settings.toneMapping],
      SRGBColorSpace
    );
    const adjusted = vibrance(
      saturation(display.rgb, uniforms.saturation),
      uniforms.vibrance
    );
    const next = new RenderPipeline(renderer);
    next.outputColorTransform = false;
    next.outputNode = vec4(grades[filter(settings)](adjusted), display.a);
    pipeline = next;
  };
  return {
    configure(settings: RenderSettings) {
      uniforms.aoIntensity.value = settings.aoIntensity * aoExponent;
      uniforms.exposure.value = settings.exposure;
      uniforms.giIntensity.value = settings.giIntensity;
      uniforms.saturation.value = settings.saturation;
      uniforms.vibrance.value = settings.vibrance;
      const next = settings.quality === "off" ? "" : structure(settings);
      if (next === signature) {
        return;
      }
      signature = next;
      failed = false;
      release();
      if (next) {
        build(settings);
      }
      onStatus?.(status());
    },
    dispose: release,
    render() {
      if (pipeline && !failed) {
        try {
          pipeline.render();
          return;
        } catch {
          // A stage the device cannot compile must not blank the chart.
          failed = true;
          release();
          onStatus?.(status());
        }
      }
      renderer.render(scene, camera);
    },
    status,
  };
}
