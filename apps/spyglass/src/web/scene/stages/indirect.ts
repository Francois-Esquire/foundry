import { diffuseColor, vec4 } from "three/tsl";
import type { Stage } from "./stage";

type IndirectInputs = typeof import("three/addons/tsl/display/SSGINode.js");

/**
 * Screen-space indirect light: the scene's albedo lit by its own bounce,
 * added to the image, with the method's own occlusion multiplied in. Needs
 * a perspective camera, so only the wreck dives take it.
 */
export const indirect: Stage<IndirectInputs> = {
  apply(frame, inputs) {
    const { camera, depth, normal, quality, uniforms } = frame;
    // The normal is read from depth (`StageFrame.normal`); the method also
    // declares a perspective camera, which `needs` has checked.
    const light = inputs.ssgi(
      frame.color,
      depth,
      normal as never,
      camera as never
    );
    light.useTemporalFiltering = false;
    light.sliceCount.value = quality.giSlices;
    light.stepCount.value = quality.giSteps;
    frame.nodes.push(light);
    const bounce = frame
      .target("diffuseColor")
      .rgb.mul(light.getGINode().rgb)
      .mul(uniforms.giIntensity);
    frame.color = vec4(
      frame.color.rgb.mul(light.getAONode().r).add(bounce),
      frame.color.a
    );
    return vec4(bounce, 1);
  },
  id: "indirect",
  label: "Indirect light",
  load: () => import("three/addons/tsl/display/SSGINode.js"),
  needs(settings, _tier, { perspective }) {
    return settings.globalIllumination && perspective;
  },
  targets: { diffuseColor },
};
