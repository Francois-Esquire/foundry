import { useEffect, useRef } from "react";
import type { Bitmap, RasterImage } from "~/generation/raster/bitmap";
import { useTheme } from "~/ui/theme";

const CHANNELS = 4;
const COLOUR = /\d+(\.\d+)?/g;

/** The red, green and blue of a computed CSS colour such as rgb(11, 12, 13). */
const channelsOf = (colour: string): readonly [number, number, number] => {
  const [red = 0, green = 0, blue = 0] = (colour.match(COLOUR) ?? []).map(
    Number
  );
  return [red, green, blue];
};

/** The ink of the theme a canvas sits in, read from its own text colour. */
const inkOf = (canvas: HTMLCanvasElement | null) =>
  channelsOf(canvas ? getComputedStyle(canvas).color : "");

const paint = (
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
  data: Uint8ClampedArray<ArrayBuffer>
) => {
  if (!canvas || width === 0 || height === 0) {
    return;
  }
  canvas.width = width;
  canvas.height = height;
  canvas
    .getContext("2d")
    ?.putImageData(new ImageData(data, width, height), 0, 0);
};

interface PixelPictureProps {
  readonly image: RasterImage;
  /** What the picture shows, for someone who cannot see it. */
  readonly label: string;
}

/** Decoded pixels shown as they are: a region of the photograph seen upright. */
export function PixelPicture({ image, label }: PixelPictureProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    paint(
      canvas.current,
      image.width,
      image.height,
      new Uint8ClampedArray(image.data)
    );
  }, [image]);
  return (
    <canvas
      aria-label={label}
      className="ty-reconstruct-pixels"
      ref={canvas}
      role="img"
    />
  );
}

interface InkPictureProps {
  readonly ink: Bitmap;
  readonly label: string;
}

/**
 * An ink map printed in the interface's ink on its tape: lettering lifted
 * off the photograph, with nothing of the photograph left in it.
 */
export function InkPicture({ ink, label }: InkPictureProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The ink is read from the theme, so the picture is printed again when it changes.
  const theme = useTheme();
  useEffect(() => {
    const [red, green, blue] = inkOf(canvas.current);
    const data = new Uint8ClampedArray(ink.data.length * CHANNELS);
    for (const [pixel, level] of ink.data.entries()) {
      data[pixel * CHANNELS] = red;
      data[pixel * CHANNELS + 1] = green;
      data[pixel * CHANNELS + 2] = blue;
      data[pixel * CHANNELS + 3] = level;
    }
    paint(canvas.current, ink.width, ink.height, data);
  }, [ink, theme]);
  return (
    <canvas
      aria-label={label}
      className="ty-reconstruct-pixels"
      ref={canvas}
      role="img"
    />
  );
}
