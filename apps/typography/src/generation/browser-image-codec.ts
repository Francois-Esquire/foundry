/**
 * The browser adapter for image files: the only file in this context that
 * uses browser globals. It decodes and encodes with a canvas.
 */
import type { ImageCodec } from "./raster/image-codec";
import { UnreadableImageError } from "./raster/image-codec";

const contextOf = (canvas: OffscreenCanvas) => {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new UnreadableImageError("This browser cannot draw to a canvas.");
  }
  return context;
};

export const browserImageCodec: ImageCodec = {
  async decode({ bytes, mediaType }) {
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
      type: mediaType,
    });
    let picture: ImageBitmap;
    try {
      picture = await createImageBitmap(blob);
    } catch (cause) {
      throw new UnreadableImageError(
        `This file could not be read as an image (${mediaType}).`,
        { cause }
      );
    }
    const canvas = new OffscreenCanvas(picture.width, picture.height);
    const context = contextOf(canvas);
    context.drawImage(picture, 0, 0);
    picture.close();
    const { data, height, width } = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    );
    return { data, height, width };
  },
  async encodePng({ data, height, width }) {
    const canvas = new OffscreenCanvas(width, height);
    contextOf(canvas).putImageData(
      new ImageData(new Uint8ClampedArray(data), width, height),
      0,
      0
    );
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  },
};
