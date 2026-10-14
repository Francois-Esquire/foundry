import { perimeter } from "@s/b";

import { describe } from "./index";

export function check(): boolean {
  const tile = { label: "t", width: 1, height: 1 };
  return describe(tile).length > 0 && perimeter(tile) === 4;
}
