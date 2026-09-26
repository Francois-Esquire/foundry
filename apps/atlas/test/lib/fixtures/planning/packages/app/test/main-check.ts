import { Widget } from "@p/core";

export function check(): number {
  return new Widget(1, { min: 0, max: 1 }).area();
}
