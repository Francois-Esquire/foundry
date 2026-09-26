import { Bar, Qux } from "@traffic/hub";

export function runB(): Qux {
  return new Qux(Bar());
}
