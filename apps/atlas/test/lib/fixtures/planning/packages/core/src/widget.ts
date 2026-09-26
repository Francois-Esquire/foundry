import type { Range } from "@p/util";

import { clamp } from "@p/util";

import type { Shape } from "./shape";

function square(n: number): number {
  return n * n;
}

export class Widget implements Shape {
  constructor(
    private readonly size: number,
    private readonly range: Range,
  ) {}

  area(): number {
    return clamp(square(this.size), this.range);
  }
}
