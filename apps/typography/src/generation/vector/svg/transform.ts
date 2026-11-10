/** SVG `transform` attributes as outline transforms. */
import type { Transform } from "~/typeface/outline";

export const IDENTITY: Transform = {
  dx: 0,
  dy: 0,
  xx: 1,
  xy: 0,
  yx: 0,
  yy: 1,
};

/** The transform that applies `inner` first and then `outer`. */
export const composeTransforms = (
  outer: Transform,
  inner: Transform
): Transform => ({
  dx: outer.xx * inner.dx + outer.yx * inner.dy + outer.dx,
  dy: outer.xy * inner.dx + outer.yy * inner.dy + outer.dy,
  xx: outer.xx * inner.xx + outer.yx * inner.xy,
  xy: outer.xy * inner.xx + outer.yy * inner.xy,
  yx: outer.xx * inner.yx + outer.yx * inner.yy,
  yy: outer.xy * inner.yx + outer.yy * inner.yy,
});

const translate = (dx: number, dy: number): Transform => ({
  ...IDENTITY,
  dx,
  dy,
});

const rotate = (degrees: number): Transform => {
  const angle = (degrees * Math.PI) / 180;
  return {
    dx: 0,
    dy: 0,
    xx: Math.cos(angle),
    xy: Math.sin(angle),
    yx: -Math.sin(angle),
    yy: Math.cos(angle),
  };
};

const tangent = (degrees: number) => Math.tan((degrees * Math.PI) / 180);

const FUNCTIONS: Readonly<
  Record<string, (values: readonly number[]) => Transform | undefined>
> = {
  matrix: ([xx, xy, yx, yy, dx, dy]) =>
    dy === undefined || dx === undefined
      ? undefined
      : {
          dx,
          dy,
          xx: xx ?? 1,
          xy: xy ?? 0,
          yx: yx ?? 0,
          yy: yy ?? 1,
        },
  rotate: ([degrees = 0, cx, cy]) =>
    cx === undefined || cy === undefined
      ? rotate(degrees)
      : composeTransforms(
          translate(cx, cy),
          composeTransforms(rotate(degrees), translate(-cx, -cy))
        ),
  scale: ([sx = 1, sy]) => ({ ...IDENTITY, xx: sx, yy: sy ?? sx }),
  skewX: ([degrees = 0]) => ({ ...IDENTITY, yx: tangent(degrees) }),
  skewY: ([degrees = 0]) => ({ ...IDENTITY, xy: tangent(degrees) }),
  translate: ([dx = 0, dy = 0]) => translate(dx, dy),
};

const CALL = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
const SEPARATOR = /[\s,]+/;

/** Reads a transform list. The leftmost function is applied last, as in SVG. */
export const parseTransform = (value: string | undefined): Transform => {
  let transform = IDENTITY;
  for (const [, name = "", body = ""] of (value ?? "").matchAll(CALL)) {
    const values = body
      .trim()
      .split(SEPARATOR)
      .filter((part) => part !== "")
      .map(Number);
    const next = FUNCTIONS[name]?.(values);
    if (next) {
      transform = composeTransforms(transform, next);
    }
  }
  return transform;
};
