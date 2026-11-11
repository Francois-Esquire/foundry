/**
 * The Node adapter for image files, for the command line, scripts and tests.
 * It reads PNG and JPEG with pure JavaScript libraries and writes PNG. The
 * browser uses a canvas instead (browser-image-codec.ts), and nothing the
 * browser loads may import this file.
 */
import { convertIndexedToRgb, decode, encode, hasPngSignature } from "fast-png";
import { decode as decodeJpeg } from "jpeg-js";
import type { RasterImage } from "./raster/bitmap";
import { type ImageCodec, UnreadableImageError } from "./raster/image-codec";

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

/** Spreads grey, grey with alpha, RGB or RGBA samples into four bytes a pixel. */
const toRgba = (
  samples: ArrayLike<number>,
  channels: number,
  depth: number,
  pixels: number
): Uint8Array => {
  const data = new Uint8Array(pixels * 4);
  const divisor = depth === 16 ? 256 : 1;
  const sample = (pixel: number, channel: number) =>
    Math.floor((samples[pixel * channels + channel] ?? 0) / divisor);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const grey = channels < 3;
    data[pixel * 4] = sample(pixel, 0);
    data[pixel * 4 + 1] = sample(pixel, grey ? 0 : 1);
    data[pixel * 4 + 2] = sample(pixel, grey ? 0 : 2);
    data[pixel * 4 + 3] =
      channels === 2 || channels === 4 ? sample(pixel, channels - 1) : 255;
  }
  return data;
};

const decodePng = (bytes: Uint8Array): RasterImage => {
  const png = decode(bytes);
  const pixels = png.width * png.height;
  if (png.palette) {
    const colours = convertIndexedToRgb(png);
    return {
      data: toRgba(colours, colours.length / pixels, 8, pixels),
      height: png.height,
      width: png.width,
    };
  }
  if (png.depth !== 8 && png.depth !== 16) {
    throw new UnreadableImageError(
      `A PNG with ${png.depth} bits a sample is not read here.`
    );
  }
  return {
    data: toRgba(png.data, png.channels, png.depth, pixels),
    height: png.height,
    width: png.width,
  };
};

const isJpeg = (bytes: Uint8Array) =>
  JPEG_SIGNATURE.every((value, index) => bytes[index] === value);

export const nodeImageCodec: ImageCodec = {
  decode({ bytes, mediaType }) {
    if (hasPngSignature(bytes)) {
      return Promise.resolve(decodePng(bytes));
    }
    if (isJpeg(bytes)) {
      const { data, height, width } = decodeJpeg(bytes, {
        formatAsRGBA: true,
        useTArray: true,
      });
      return Promise.resolve({ data, height, width });
    }
    throw new UnreadableImageError(
      `Only PNG and JPEG files are read in Node, and this file (${mediaType}) is neither.`
    );
  },
  encodePng({ data, height, width }) {
    return Promise.resolve(
      encode({
        channels: 4,
        data: new Uint8Array(data),
        depth: 8,
        height,
        width,
      })
    );
  },
};
