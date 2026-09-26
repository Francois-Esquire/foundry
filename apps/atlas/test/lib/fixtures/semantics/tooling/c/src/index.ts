import type { Shape } from "@s/b";

import { perimeter } from "@s/b";

import type { Unit } from "./unit";

import { pad } from "./pad";

export function fence(shape: Shape): number {
  const unit: Unit = "px";
  return perimeter(shape) + pad(unit);
}
