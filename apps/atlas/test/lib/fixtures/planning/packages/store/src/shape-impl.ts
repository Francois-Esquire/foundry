import type { Shape } from "@p/core";
import type { Range } from "@p/util";

export class Circle implements Shape {
  constructor(private readonly r: number) {}

  area(): number {
    const bounds: Range = { min: 0, max: 1000 };
    return Math.min(bounds.max, this.r * this.r * 3);
  }
}
