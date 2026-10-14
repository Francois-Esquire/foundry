import { UNIT_SIZE } from "./unit";

export function pad(unit: string): number {
  return unit === "px" ? UNIT_SIZE : 0;
}
