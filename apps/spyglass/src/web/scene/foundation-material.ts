import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RedFormat,
} from "three";
import type { SpyglassFoundation } from "../data/types";
import { foundationField } from "../layout/foundation-field";

/** One small texture updated on focus changes; it never rebuilds scene geometry. */
export function createFoundationTexture(
  foundations: readonly SpyglassFoundation[],
  extent: { width: number; height: number }
) {
  let focus = "";
  const field = foundationField(foundations, extent);
  const data = Uint16Array.from(field.values, DataUtils.toHalfFloat);
  const texture = new DataTexture(
    data,
    field.width,
    field.height,
    RedFormat,
    HalfFloatType
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return {
    setFocus(next: string) {
      if (next === focus) {
        return;
      }
      focus = next;
      const nextField = foundationField(foundations, extent, focus);
      for (let index = 0; index < data.length; index += 1) {
        data[index] = DataUtils.toHalfFloat(nextField.values[index] ?? 0);
      }
      texture.needsUpdate = true;
    },
    texture,
  };
}
