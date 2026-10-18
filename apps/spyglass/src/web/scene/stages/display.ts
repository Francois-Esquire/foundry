import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  ReinhardToneMapping,
  SRGBColorSpace,
} from "three";
import { renderOutput, saturation, vec4, vibrance } from "three/tsl";
import type { Stage } from "./stage";

const toneMappingModes = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  none: NoToneMapping,
  reinhard: ReinhardToneMapping,
} as const;

/**
 * The last stage, always built: exposure, the chosen tone mapping and the
 * sRGB transfer, then saturation and vibrance. Its output is the finished
 * image, so its view is the final one.
 */
export const display: Stage<null> = {
  apply(frame) {
    const { settings, uniforms } = frame;
    const exposed = vec4(frame.color.rgb.mul(uniforms.exposure), frame.color.a);
    const encoded = renderOutput(
      exposed,
      toneMappingModes[settings.toneMapping],
      SRGBColorSpace
    );
    const graded = vibrance(
      saturation(encoded.rgb, uniforms.saturation),
      uniforms.vibrance
    );
    frame.color = vec4(graded, encoded.a);
    return frame.color;
  },
  id: "final",
  label: "Final image",
  load: () => Promise.resolve(null),
  needs() {
    return true;
  },
};
