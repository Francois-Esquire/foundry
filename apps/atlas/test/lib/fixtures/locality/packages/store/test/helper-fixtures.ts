import type { Helper } from "@l/core";

export function helper1(): Helper {
  return { h: 1 };
}
export function helper2(): Helper {
  return { h: 2 };
}
export function helper3(): Helper {
  return { h: 3 };
}
export function helper4(): Helper {
  return { h: 4 };
}
export function helper5(): Helper {
  return { h: 5 };
}
export function helper6(helper: Helper): number {
  return helper.h;
}
export function helper7(helper: Helper): number {
  return helper.h + 1;
}
export function helper8(helper: Helper): number {
  return helper.h + 2;
}
export function helper9(helper: Helper): number {
  return helper.h + 3;
}
export function helper10(helper: Helper): number {
  return helper.h + 4;
}
