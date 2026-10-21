import { vec4 } from "three/tsl";
import type { RenderSettings } from "../../settings/chart-settings";
import {
  aoFromDepth,
  type ColorNode,
  denoiseFromDepth,
  type PipelineUniforms,
  type Stage,
} from "./stage";

/**
 * Occlusion strength 1 maps to this exponent on the raw GTAO term. Relief
 * on the chart is gentle, so strength is an exponent on the occlusion term
 * rather than a linear mix; it deepens valleys and the foot of buildings
 * without clipping.
 */
const aoExponent = 3;
/**
 * The chart is viewed at a tilt, so samples along flat paper still differ in
 * view depth; the thickness must exceed that spread, so it is this many
 * radii.
 */
const thicknessRadii = 2;

/** Sets the strength the occlusion stage reads, from the reader's setting. */
export function occlusionStrength(
  uniforms: Pick<PipelineUniforms, "aoIntensity">,
  settings: Pick<RenderSettings, "aoIntensity">
): void {
  uniforms.aoIntensity.value = settings.aoIntensity * aoExponent;
}

/**
 * Sets the reach the occlusion stage samples over, from the reader's
 * setting in screen pixels and the world units one pixel spans at the
 * point of interest, so the look holds at every zoom.
 */
export function occlusionReach(
  uniforms: Pick<PipelineUniforms, "aoRadius" | "aoThickness">,
  settings: Pick<RenderSettings, "aoReach">,
  unitsPerPixel: number
): void {
  const radius = settings.aoReach * unitsPerPixel;
  uniforms.aoRadius.value = radius;
  uniforms.aoThickness.value = radius * thicknessRadii;
}

interface OcclusionInputs {
  ao: typeof import("three/addons/tsl/display/GTAONode.js");
  denoise: typeof import("three/addons/tsl/display/DenoiseNode.js");
}

/**
 * Screen-space occlusion from the depth, denoised on the tiers that ask for
 * it, multiplied into the image. The chart's relief is engraved by the paper
 * material instead on the Light tier, where this stage is kept for its view
 * and for the perspective wreck dives.
 */
export const occlusion: Stage<OcclusionInputs> = {
  apply(frame, inputs) {
    const { camera, depth, quality, uniforms } = frame;
    const shade = aoFromDepth(inputs.ao.ao, depth, camera);
    shade.resolutionScale = quality.aoResolution;
    shade.samples.value = quality.aoSamples;
    shade.radius = uniforms.aoRadius;
    shade.thickness = uniforms.aoThickness;
    shade.distanceFallOff.value = 0.4;
    shade.scale = uniforms.aoIntensity;
    frame.nodes.push(shade);
    let term: ColorNode = shade.getTextureNode();
    if (quality.denoise) {
      const smoothed = denoiseFromDepth(
        inputs.denoise.denoise,
        term,
        depth,
        camera
      );
      frame.nodes.push(smoothed);
      // The denoiser's declaration omits its vec4 output type.
      term = smoothed as unknown as ColorNode;
    }
    frame.color = vec4(frame.color.rgb.mul(term.r), frame.color.a);
    return vec4(term.rrr, 1);
  },
  id: "occlusion",
  label: "Occlusion",
  async load() {
    const [ao, denoise] = await Promise.all([
      import("three/addons/tsl/display/GTAONode.js"),
      import("three/addons/tsl/display/DenoiseNode.js"),
    ]);
    return { ao, denoise };
  },
  needs(settings, tier, { perspective }) {
    return (
      settings.ambientOcclusion &&
      (tier !== "low" || perspective || settings.stage === "occlusion")
    );
  },
};
