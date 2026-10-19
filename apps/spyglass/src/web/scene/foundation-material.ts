import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGFormat,
} from "three";
import type { FoundationGroup } from "../../lib/visualization/types";
import { createFoundationFields } from "../layout/foundation-field";
import { foundationRelief } from "../layout/foundation-relief";

/** One small texture updated on focus changes; it never rebuilds scene geometry. */
export function createFoundationTexture(
  groups: readonly FoundationGroup[],
  extent: { width: number; height: number }
) {
  let focus = "";
  const fields = createFoundationFields(groups, extent, 1024);
  const field = fields.compose();
  const data = Uint16Array.from(
    foundationRelief(field, extent),
    DataUtils.toHalfFloat
  );
  const texture = new DataTexture(
    data,
    field.width,
    field.height,
    RGFormat,
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
      const nextField = foundationRelief(fields.compose(focus), extent);
      for (let index = 0; index < data.length; index += 1) {
        data[index] = DataUtils.toHalfFloat(nextField[index] ?? 0);
      }
      texture.needsUpdate = true;
    },
    texture,
  };
}
