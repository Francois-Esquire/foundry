import { vec4 } from "three/tsl";
import type { Stage } from "./stage";

type BloomInputs = typeof import("three/addons/tsl/display/BloomNode.js");

/** A glow from the brightest ink, at the tier's resolution, added to the image. */
export const bloom: Stage<BloomInputs> = {
  apply(frame, inputs) {
    const { quality, uniforms } = frame;
    const glow = inputs.bloom(
      frame.color,
      uniforms.bloomStrength,
      uniforms.bloomRadius,
      uniforms.bloomThreshold
    );
    glow.setResolutionScale(quality.bloomResolution);
    frame.nodes.push(glow);
    frame.color = vec4(frame.color.rgb.add(glow.rgb), frame.color.a);
    return vec4(glow.rgb, 1);
  },
  id: "bloom",
  label: "Bloom only",
  load: () => import("three/addons/tsl/display/BloomNode.js"),
  needs(settings) {
    return settings.bloom;
  },
};
