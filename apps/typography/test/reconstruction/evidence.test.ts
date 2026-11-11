import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nodeImageCodec } from "~/generation/node-image-codec";
import {
  type Bitmap,
  inkAt,
  intersectionOverUnion,
} from "~/generation/raster/bitmap";
import { flattenOutline } from "~/generation/raster/flatten";
import { UnreadableImageError } from "~/generation/raster/image-codec";
import { rasterizePolygons } from "~/generation/raster/rasterize";
import { importEvidence } from "~/reconstruction/evidence/evidence";
import { viewRegion } from "~/reconstruction/evidence/rectify";
import {
  quadrilateralRegion,
  rectangleRegion,
} from "~/reconstruction/evidence/region";
import { isolateLettering } from "~/reconstruction/isolation/isolate";
import { reconstruct } from "~/reconstruction/reconstruct";
import { outlineOnEvidence } from "~/reconstruction/recovery/correspondence";
import type { Point } from "~/typeface/outline";
import {
  evidenceBytes,
  fixtureFace,
  PHOTOGRAPHS,
  photograph,
} from "./helpers/evidence";
import {
  plainPicture,
  setLettering,
  syntheticEvidence,
} from "./helpers/lettering";

describe("evidence", () => {
  it("is named by the SHA-256 of its file and keeps the file and its size", async () => {
    const bytes = evidenceBytes("storefront");
    const evidence = await photograph("storefront");
    expect(evidence.id).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(evidence.fileName).toBe(PHOTOGRAPHS.storefront);
    expect([evidence.width, evidence.height]).toEqual([1280, 960]);
    expect(evidence.pixels.data).toHaveLength(1280 * 960 * 4);
    expect(evidence.file.bytes).toEqual(bytes);
  });

  it("does not change when the bytes it was read from are written to", async () => {
    const bytes = evidenceBytes("handwriting");
    const evidence = await importEvidence(
      { bytes, fileName: "sample.jpg", mediaType: "image/jpeg" },
      nodeImageCodec
    );
    const [first] = evidence.file.bytes;
    bytes.fill(0);
    expect(evidence.file.bytes[0]).toBe(first);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("refuses a file that is not a picture", async () => {
    await expect(
      importEvidence(
        {
          bytes: new TextEncoder().encode("not a picture"),
          fileName: "notes.jpg",
          mediaType: "image/jpeg",
        },
        nodeImageCodec
      )
    ).rejects.toBeInstanceOf(UnreadableImageError);
  });
});

const pixelAt = (
  image: { data: ArrayLike<number>; width: number },
  x: number,
  y: number
) =>
  [0, 1, 2].map((channel) => image.data[(y * image.width + x) * 4 + channel]);

describe("a rectangular region", () => {
  it("is cut out pixel for pixel, and maps back by one transform", async () => {
    const evidence = await photograph("storefront");
    const view = viewRegion(
      evidence.pixels,
      rectangleRegion(432, 162, 400, 196)
    );
    expect([view.image.width, view.image.height]).toEqual([400, 196]);
    expect(pixelAt(view.image, 10, 20)).toEqual(
      pixelAt(evidence.pixels, 442, 182)
    );
    expect(view.toEvidence({ x: 10, y: 20 })).toEqual({ x: 442, y: 182 });
    expect(view.viewToEvidence).toEqual({
      dx: 432,
      dy: 162,
      xx: 1,
      xy: 0,
      yx: 0,
      yy: 1,
    });
  });

  it("can be enlarged, and still maps back to the same place", async () => {
    const evidence = await photograph("storefront");
    const view = viewRegion(
      evidence.pixels,
      rectangleRegion(432, 162, 400, 196),
      {
        scale: 2,
      }
    );
    expect([view.image.width, view.image.height]).toEqual([800, 392]);
    expect(view.toEvidence({ x: 20, y: 40 })).toEqual({ x: 442, y: 182 });
  });
});

/**
 * A known view from an angle, written out by hand so the test does not lean
 * on the code it checks: x and y are divided by a depth that grows to the
 * right and downwards.
 */
const fromAnAngle = ({ x, y }: Point): Point => {
  const depth = 0.0006 * x + 0.0003 * y + 1;
  return {
    x: (0.9 * x + 0.12 * y + 40) / depth,
    y: (0.06 * x + 0.85 * y + 30) / depth,
  };
};

const ink = (picture: {
  data: ArrayLike<number>;
  height: number;
  width: number;
}): Bitmap => ({
  data: Uint8Array.from(
    { length: picture.width * picture.height },
    (_, pixel) => ((picture.data[pixel * 4] ?? 255) < 128 ? 255 : 0)
  ),
  height: picture.height,
  width: picture.width,
});

describe("a four-corner region", () => {
  const lettering = setLettering([
    { emSize: 120, face: fixtureFace("lato"), text: "ANGLE" },
  ]);
  const corners = [
    { x: 0, y: 0 },
    { x: lettering.width, y: 0 },
    { x: lettering.width, y: lettering.height },
    { x: 0, y: lettering.height },
  ].map(fromAnAngle) as [Point, Point, Point, Point];
  const seen = plainPicture(
    rasterizePolygons(
      lettering.polygons.map((polygon) => polygon.map(fromAnAngle)),
      Math.ceil(Math.max(...corners.map((corner) => corner.x))) + 10,
      Math.ceil(Math.max(...corners.map((corner) => corner.y))) + 10,
      { antialias: true }
    )
  );
  const view = viewRegion(seen, quadrilateralRegion(corners), { scale: 1.2 });

  it("is warped back to the lettering as it looks head on", () => {
    // The view is as large as the region's edges are long, which is not the
    // size the lettering was drawn at, so it is compared after isolating:
    // five letters, level, and each as tall as the others.
    const { lines } = isolateLettering(view.image);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line?.letters).toHaveLength(5);
    expect(Math.abs(line?.slope ?? 1)).toBeLessThan(0.005);
    const heights = (line?.letters ?? []).map(
      (letter) => letter.box.bottom - letter.box.top
    );
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2);
    // Seen from the angle, without rectifying, the same letters differ in
    // height by more than that: the far end is smaller.
    const unrectified = isolateLettering(seen).lines[0]?.letters ?? [];
    const seenHeights = unrectified.map(
      (letter) => letter.box.bottom - letter.box.top
    );
    expect(Math.max(...seenHeights) - Math.min(...seenHeights)).toBeGreaterThan(
      8
    );
  });

  it("agrees with the head-on drawing almost pixel for pixel", () => {
    // The view covers exactly the rectangle the lettering was drawn in, at
    // its own size, so each drawn pixel is looked up at the same share of
    // the way across and down.
    const rectified = ink(view.image);
    const stretched: Bitmap = {
      data: Uint8Array.from(
        { length: lettering.width * lettering.height },
        (_, pixel) => {
          const x = pixel % lettering.width;
          const y = Math.floor(pixel / lettering.width);
          return inkAt(
            rectified,
            Math.floor(((x + 0.5) * rectified.width) / lettering.width),
            Math.floor(((y + 0.5) * rectified.height) / lettering.height)
          );
        }
      ),
      height: lettering.height,
      width: lettering.width,
    };
    const drawn: Bitmap = {
      data: lettering.ink.data.map((value) => (value >= 128 ? 255 : 0)),
      height: lettering.height,
      width: lettering.width,
    };
    // 0.9: the picture is resampled on the way out and on the way back,
    // which can move an edge by a pixel on strokes about eight pixels thick.
    expect(intersectionOverUnion(drawn, stretched)).toBeGreaterThan(0.9);
  });

  it("lays recovered outlines back over the lettering as it was seen", () => {
    const { recovered } = reconstruct({
      evidence: syntheticEvidence(seen, "angle"),
      region: quadrilateralRegion(corners),
      target: { faceId: "target" },
      text: ["ANGLE"],
      view: { scale: 1.2 },
    });
    expect(recovered).toHaveLength(5);
    const laid = rasterizePolygons(
      recovered.flatMap(({ candidate, correspondence }) =>
        flattenOutline(
          outlineOnEvidence(candidate.outline, correspondence),
          0.05
        )
      ),
      seen.width,
      seen.height
    );
    // Traced in the upright view, then carried back through the projective
    // map: the outlines cover the angled lettering they started from.
    expect(intersectionOverUnion(ink(seen), laid)).toBeGreaterThan(0.93);
    // Two regions of one picture never give two letters the same id.
    expect(new Set(recovered.map((letter) => letter.candidate.id)).size).toBe(
      5
    );
  });

  it("maps a point of the view back to where it was seen", () => {
    const [topLeft, , bottomRight] = corners;
    const back = view.toEvidence({ x: 0, y: 0 });
    expect(back.x).toBeCloseTo(topLeft.x, 6);
    expect(back.y).toBeCloseTo(topLeft.y, 6);
    const far = view.toEvidence({
      x: view.image.width,
      y: view.image.height,
    });
    expect(far.x).toBeCloseTo(bottomRight.x, 6);
    expect(far.y).toBeCloseTo(bottomRight.y, 6);
    // The middle of the view is the middle of the lettering as drawn, which
    // is not the middle of the four corners: that is what perspective does.
    const middle = view.toEvidence({
      x: view.image.width / 2,
      y: view.image.height / 2,
    });
    const expected = fromAnAngle({
      x: lettering.width / 2,
      y: lettering.height / 2,
    });
    expect(middle.x).toBeCloseTo(expected.x, 6);
    expect(middle.y).toBeCloseTo(expected.y, 6);
    expect(view.viewToEvidence).toBeUndefined();
  });
});
