import { describe, expect, it } from "vitest";
import { quadrilateral, rectangle } from "~/reconstruct/core";
import {
  asCorners,
  asRectangle,
  boxAround,
  isConvex,
  orderCorners,
  quadrilateralThrough,
  rectangleBetween,
  wholePicture,
  withRegionNumber,
} from "~/reconstruct/region-geometry";

const PICTURE = { height: 960, width: 1280 };

describe("a dragged rectangle", () => {
  it("is the same region whichever corner the drag starts from", () => {
    const expected = rectangle(432, 162, 400, 196);
    expect(
      rectangleBetween({ x: 432, y: 162 }, { x: 832, y: 358 }, PICTURE)
    ).toEqual(expected);
    expect(
      rectangleBetween({ x: 832, y: 358 }, { x: 432, y: 162 }, PICTURE)
    ).toEqual(expected);
  });

  it("stops at the edge of the photograph", () => {
    expect(
      rectangleBetween({ x: -40, y: 900 }, { x: 300.4, y: 1200 }, PICTURE)
    ).toEqual(rectangle(0, 900, 300, 60));
  });

  it("is nothing when the drag was a stray click", () => {
    expect(
      rectangleBetween({ x: 100, y: 100 }, { x: 103, y: 400 }, PICTURE)
    ).toBeUndefined();
  });
});

describe("four placed corners", () => {
  const topLeft = { x: 100, y: 120 };
  const topRight = { x: 900, y: 60 };
  const bottomRight = { x: 920, y: 400 };
  const bottomLeft = { x: 110, y: 330 };

  it("are read in reading order however they were placed", () => {
    expect(orderCorners([bottomRight, topLeft, bottomLeft, topRight])).toEqual([
      topLeft,
      topRight,
      bottomRight,
      bottomLeft,
    ]);
  });

  it("make a region when they enclose one", () => {
    expect(
      quadrilateralThrough(
        [bottomLeft, topRight, topLeft, bottomRight],
        PICTURE
      )
    ).toEqual(quadrilateral([topLeft, topRight, bottomRight, bottomLeft]));
  });

  it("make nothing when they lie on one line or are too few", () => {
    const line = [0, 100, 200, 300].map((x) => ({ x, y: 50 }));
    expect(quadrilateralThrough(line, PICTURE)).toBeUndefined();
    expect(
      quadrilateralThrough([topLeft, topRight, bottomRight], PICTURE)
    ).toBeUndefined();
  });

  it("tells a shape with a corner pushed inwards from a convex one", () => {
    expect(isConvex([topLeft, topRight, bottomRight, bottomLeft])).toBe(true);
    expect(isConvex([topLeft, topRight, { x: 300, y: 150 }, bottomLeft])).toBe(
      false
    );
  });
});

describe("the same place marked the other way", () => {
  it("turns a rectangle into its corners and back", () => {
    const banner = rectangle(432, 162, 400, 196);
    const corners = asCorners(banner);
    expect(corners).toEqual(
      quadrilateral([
        { x: 432, y: 162 },
        { x: 832, y: 162 },
        { x: 832, y: 358 },
        { x: 432, y: 358 },
      ])
    );
    expect(asRectangle(corners, PICTURE)).toEqual(banner);
  });

  it("marks the whole photograph", () => {
    expect(wholePicture(PICTURE)).toEqual(rectangle(0, 0, 1280, 960));
  });

  it("boxes points with a margin, inside the photograph", () => {
    expect(
      boxAround(
        [
          { x: 10, y: 20 },
          { x: 110, y: 70 },
        ],
        PICTURE,
        30
      )
    ).toEqual({ height: 100, width: 140, x: 0, y: 0 });
  });
});

describe("a typed number", () => {
  const banner = rectangle(432, 162, 400, 196);

  it("replaces one side of a rectangle", () => {
    expect(
      withRegionNumber(
        banner,
        { kind: "rectangle", part: "width" },
        380,
        PICTURE
      )
    ).toEqual(rectangle(432, 162, 380, 196));
  });

  it("is refused when it leaves no region", () => {
    expect(
      withRegionNumber(
        banner,
        { kind: "rectangle", part: "height" },
        2,
        PICTURE
      )
    ).toBeUndefined();
    expect(
      withRegionNumber(
        banner,
        { kind: "rectangle", part: "x" },
        Number.NaN,
        PICTURE
      )
    ).toBeUndefined();
  });

  it("moves one corner, and is refused when the corners would cross", () => {
    const corners = asCorners(banner);
    expect(
      withRegionNumber(
        corners,
        { axis: "y", corner: 1, kind: "corner" },
        150,
        PICTURE
      )
    ).toEqual(
      quadrilateral([
        { x: 432, y: 162 },
        { x: 832, y: 150 },
        { x: 832, y: 358 },
        { x: 432, y: 358 },
      ])
    );
    expect(
      withRegionNumber(
        corners,
        { axis: "x", corner: 1, kind: "corner" },
        300,
        PICTURE
      )
    ).toBeUndefined();
  });

  it("does not apply a corner's number to a rectangle", () => {
    expect(
      withRegionNumber(
        banner,
        { axis: "x", corner: 0, kind: "corner" },
        10,
        PICTURE
      )
    ).toBeUndefined();
  });
});
