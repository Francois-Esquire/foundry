import { type CSSProperties, useMemo } from "react";
import type { Bitmap } from "~/generation/raster/bitmap";
import { ScrollRegion } from "~/ui/layout/scroll-region";
import { PIXEL } from "./visual-regression";

const LAYERS = [
  { name: "both", value: PIXEL.both },
  { name: "source", value: PIXEL.sourceOnly },
  { name: "derived", value: PIXEL.derivedOnly },
] as const;

const ALPHA = 3;
const CHANNELS = 4;

/**
 * One layer of the picture as an image whose only content is opacity: opaque
 * where the pixel has this value. Used as a CSS mask, so the layer takes its
 * colour from a design token and follows the theme.
 */
const maskOf = (picture: Bitmap, value: number): string | undefined => {
  const canvas = document.createElement("canvas");
  canvas.width = picture.width;
  canvas.height = picture.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const image = context.createImageData(picture.width, picture.height);
  for (let index = 0; index < picture.data.length; index += 1) {
    if (picture.data[index] === value) {
      image.data[index * CHANNELS + ALPHA] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return `url(${canvas.toDataURL("image/png")})`;
};

/**
 * Where two rasterised lines differ, one screen pixel per compared pixel.
 * Ink is drawn only by the source, carbon only by the derived font, and the
 * pale layer is what both draw.
 */
export function DifferencePicture({
  label,
  picture,
}: {
  readonly label: string;
  readonly picture: Bitmap;
}) {
  const layers = useMemo(
    () =>
      LAYERS.map(({ name, value }) => ({ mask: maskOf(picture, value), name })),
    [picture]
  );
  return (
    <ScrollRegion axis="x" label={label}>
      <div
        className="ty-proof-difference"
        style={{ height: picture.height, width: picture.width }}
      >
        {layers.map(({ mask, name }) => (
          <span
            data-layer={name}
            key={name}
            style={{ maskImage: mask, WebkitMaskImage: mask } as CSSProperties}
          />
        ))}
      </div>
    </ScrollRegion>
  );
}
