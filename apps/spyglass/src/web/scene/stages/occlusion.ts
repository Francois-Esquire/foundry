import { vec4 } from "three/tsl";
import type { ColorNode, Stage } from "./stage";

/** Occlusion strength 1 maps to this exponent on the raw GTAO term. */
export const aoExponent = 3;

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
    const { camera, depth, normal, quality, uniforms } = frame;
    // The display nodes take a null normal and read it from depth, though
    // their declarations ask for a node.
    const shade = inputs.ao.ao(depth, normal as never, camera);
    shade.resolutionScale = quality.aoResolution;
    shade.samples.value = quality.aoSamples;
    shade.radius = uniforms.aoRadius;
    shade.thickness = uniforms.aoThickness;
    shade.distanceFallOff.value = 0.4;
    // Relief on the chart is gentle, so strength is an exponent on the
    // occlusion term rather than a linear mix; it deepens valleys and the
    // foot of buildings without clipping.
    shade.scale = uniforms.aoIntensity;
    frame.nodes.push(shade);
    let term: ColorNode = shade.getTextureNode();
    if (quality.denoise) {
      const smoothed = inputs.denoise.denoise(
        term,
        depth,
        normal as never,
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
