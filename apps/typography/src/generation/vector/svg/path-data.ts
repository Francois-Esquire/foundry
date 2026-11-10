/**
 * SVG path data as contours. Every command is read, absolute and relative.
 * A glyph is a filled shape, so a subpath left open is closed the way a fill
 * closes it.
 */
import type { Contour, Point, Segment } from "~/typeface/outline";
import { arcToCubics } from "./arc";

const NUMBER = /[\s,]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
const FLAG = /[\s,]*([01])/y;
const COMMAND = /[\s,]*([MmLlHhVvCcSsQqTtAaZz])/y;

/** Reads commands, numbers and arc flags in order from path data. */
class PathScanner {
  readonly #source: string;
  #position = 0;

  constructor(source: string) {
    this.#source = source;
  }

  #read(pattern: RegExp): string | undefined {
    pattern.lastIndex = this.#position;
    const text = this.#source.match(pattern)?.[1];
    if (text !== undefined) {
      this.#position = pattern.lastIndex;
    }
    return text;
  }

  command() {
    return this.#read(COMMAND);
  }

  number(): number | undefined {
    const text = this.#read(NUMBER);
    return text === undefined ? undefined : Number(text);
  }

  flag(): boolean | undefined {
    const text = this.#read(FLAG);
    return text === undefined ? undefined : text === "1";
  }

  /** Reads `count` numbers, or nothing at all when the data runs out. */
  numbers(count: number): number[] | undefined {
    const start = this.#position;
    const values: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const value = this.number();
      if (value === undefined) {
        this.#position = start;
        return;
      }
      values.push(value);
    }
    return values;
  }
}

/** The pen while a path is drawn. */
class PathPen {
  readonly contours: Contour[] = [];
  #segments: Segment[] = [];
  #start: Point = { x: 0, y: 0 };
  current: Point = { x: 0, y: 0 };
  /** The last control point, for the smooth commands S and T. */
  #reflect:
    | { readonly kind: "cubic" | "quadratic"; readonly at: Point }
    | undefined;

  moveTo(to: Point) {
    this.close();
    this.#start = to;
    this.current = to;
  }

  close() {
    if (this.#segments.length > 0) {
      this.contours.push({ segments: this.#segments, start: this.#start });
    }
    this.#segments = [];
    this.current = this.#start;
    this.#reflect = undefined;
  }

  draw(segment: Segment) {
    this.#segments.push(segment);
    this.current = segment.to;
    this.#reflect = undefined;
    if (segment.kind === "cubic") {
      this.#reflect = { at: segment.control2, kind: "cubic" };
    } else if (segment.kind === "quadratic") {
      this.#reflect = { at: segment.control, kind: "quadratic" };
    }
  }

  /** The mirror of the last control point, or the pen position when there is none. */
  reflected(kind: "cubic" | "quadratic"): Point {
    const last = this.#reflect;
    return last?.kind === kind
      ? { x: 2 * this.current.x - last.at.x, y: 2 * this.current.y - last.at.y }
      : this.current;
  }
}

interface Drawing {
  readonly pen: PathPen;
  readonly relative: boolean;
  readonly scanner: PathScanner;
}

/** A point read from two numbers, moved by the pen position for a relative command. */
const point = (
  { pen, relative }: Drawing,
  x: number | undefined,
  y: number | undefined
): Point => ({
  x: (x ?? 0) + (relative ? pen.current.x : 0),
  y: (y ?? 0) + (relative ? pen.current.y : 0),
});

/** Each handler draws one set of arguments and says whether it found one. */
const HANDLERS: Readonly<
  Record<string, ((drawing: Drawing) => boolean) | undefined>
> = {
  A: (drawing) => {
    const { pen, scanner } = drawing;
    const radii = scanner.numbers(3);
    const largeArc = radii && scanner.flag();
    const sweep = largeArc === undefined ? undefined : scanner.flag();
    const end = sweep === undefined ? undefined : scanner.numbers(2);
    if (!(radii && end) || largeArc === undefined || sweep === undefined) {
      return false;
    }
    const to = point(drawing, end[0], end[1]);
    const arc = {
      largeArc,
      rotation: radii[2] ?? 0,
      rx: radii[0] ?? 0,
      ry: radii[1] ?? 0,
      sweep,
    };
    for (const segment of arcToCubics(pen.current, to, arc)) {
      pen.draw(segment);
    }
    return true;
  },
  C: (drawing) => {
    const values = drawing.scanner.numbers(6);
    if (!values) {
      return false;
    }
    drawing.pen.draw({
      control1: point(drawing, values[0], values[1]),
      control2: point(drawing, values[2], values[3]),
      kind: "cubic",
      to: point(drawing, values[4], values[5]),
    });
    return true;
  },
  H: (drawing) => {
    const x = drawing.scanner.number();
    if (x === undefined) {
      return false;
    }
    const { pen, relative } = drawing;
    pen.draw({
      kind: "line",
      to: { x: x + (relative ? pen.current.x : 0), y: pen.current.y },
    });
    return true;
  },
  L: (drawing) => {
    const values = drawing.scanner.numbers(2);
    if (!values) {
      return false;
    }
    drawing.pen.draw({
      kind: "line",
      to: point(drawing, values[0], values[1]),
    });
    return true;
  },
  Q: (drawing) => {
    const values = drawing.scanner.numbers(4);
    if (!values) {
      return false;
    }
    drawing.pen.draw({
      control: point(drawing, values[0], values[1]),
      kind: "quadratic",
      to: point(drawing, values[2], values[3]),
    });
    return true;
  },
  S: (drawing) => {
    const values = drawing.scanner.numbers(4);
    if (!values) {
      return false;
    }
    drawing.pen.draw({
      control1: drawing.pen.reflected("cubic"),
      control2: point(drawing, values[0], values[1]),
      kind: "cubic",
      to: point(drawing, values[2], values[3]),
    });
    return true;
  },
  T: (drawing) => {
    const values = drawing.scanner.numbers(2);
    if (!values) {
      return false;
    }
    drawing.pen.draw({
      control: drawing.pen.reflected("quadratic"),
      kind: "quadratic",
      to: point(drawing, values[0], values[1]),
    });
    return true;
  },
  V: (drawing) => {
    const y = drawing.scanner.number();
    if (y === undefined) {
      return false;
    }
    const { pen, relative } = drawing;
    pen.draw({
      kind: "line",
      to: { x: pen.current.x, y: y + (relative ? pen.current.y : 0) },
    });
    return true;
  },
};

const moveThenLines = (drawing: Drawing) => {
  const values = drawing.scanner.numbers(2);
  if (!values) {
    return;
  }
  drawing.pen.moveTo(point(drawing, values[0], values[1]));
  // Further pairs after a move are lines, as the specification says.
  while (HANDLERS.L?.(drawing)) {
    // The handler draws.
  }
};

/** The contours a `d` attribute draws, in the path's own coordinates. */
export const parsePathData = (data: string): Contour[] => {
  const scanner = new PathScanner(data);
  const pen = new PathPen();
  for (
    let command = scanner.command();
    command !== undefined;
    command = scanner.command()
  ) {
    const letter = command.toUpperCase();
    const drawing: Drawing = { pen, relative: command !== letter, scanner };
    if (letter === "Z") {
      pen.close();
    } else if (letter === "M") {
      moveThenLines(drawing);
    } else {
      const handler = HANDLERS[letter];
      while (handler?.(drawing)) {
        // The handler draws one set of arguments each time.
      }
    }
  }
  pen.close();
  return pen.contours;
};
