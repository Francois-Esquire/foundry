import type { Foo } from "@traffic/hub";

import { Bar } from "@traffic/hub";

export function runA(foo: Foo): number {
  return Bar() + Bar() + foo.size;
}
