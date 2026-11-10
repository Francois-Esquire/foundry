/**
 * Single-channel images. In an ink map 255 is full ink and 0 is paper. Row 0
 * is the top row, so y points down here and up in an outline.
 */

export interface Bitmap {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

/** Decoded colour pixels, four bytes each: red, green, blue, alpha. */
export interface RasterImage {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly height: number;
  readonly width: number;
}

/** A rectangle of pixels. `right` and `bottom` are exclusive. */
export interface PixelBox {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

/** The ink level that separates ink from paper. */
export const INK_THRESHOLD = 128;

export const createBitmap = (width: number, height: number): Bitmap => ({
  data: new Uint8Array(Math.max(0, width) * Math.max(0, height)),
  height: Math.max(0, height),
  width: Math.max(0, width),
});

/** The ink at a pixel. Anything outside the bitmap is paper. */
export const inkAt = (bitmap: Bitmap, x: number, y: number): number =>
  x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height
    ? 0
    : (bitmap.data[y * bitmap.width + x] ?? 0);

export const boxWidth = (box: PixelBox) => box.right - box.left;

export const boxHeight = (box: PixelBox) => box.bottom - box.top;

export const unionBox = (a: PixelBox, b: PixelBox): PixelBox => ({
  bottom: Math.max(a.bottom, b.bottom),
  left: Math.min(a.left, b.left),
  right: Math.max(a.right, b.right),
  top: Math.min(a.top, b.top),
});

/** The smallest box around every pixel at or above the threshold. */
export const inkBox = (
  bitmap: Bitmap,
  threshold = INK_THRESHOLD
): PixelBox | undefined => {
  let left = bitmap.width;
  let right = -1;
  let top = bitmap.height;
  let bottom = -1;
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      if (inkAt(bitmap, x, y) >= threshold) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return right < 0
    ? undefined
    : { bottom: bottom + 1, left, right: right + 1, top };
};

/** How many pixels are at or above the threshold. */
export const inkArea = (bitmap: Bitmap, threshold = INK_THRESHOLD): number => {
  let count = 0;
  for (const value of bitmap.data) {
    if (value >= threshold) {
      count += 1;
    }
  }
  return count;
};

/**
 * Intersection over union of the ink in two bitmaps laid over each other at
 * the given offset of `b` inside `a`'s frame. Two empty bitmaps agree fully.
 */
export const intersectionOverUnion = (
  a: Bitmap,
  b: Bitmap,
  offset: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
  threshold = INK_THRESHOLD
): number => {
  const left = Math.min(0, offset.x);
  const top = Math.min(0, offset.y);
  const right = Math.max(a.width, b.width + offset.x);
  const bottom = Math.max(a.height, b.height + offset.y);
  let intersection = 0;
  let union = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const inA = inkAt(a, x, y) >= threshold;
      const inB = inkAt(b, x - offset.x, y - offset.y) >= threshold;
      if (inA || inB) {
        union += 1;
        if (inA && inB) {
          intersection += 1;
        }
      }
    }
  }
  return union === 0 ? 1 : intersection / union;
};
