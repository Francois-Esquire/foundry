// Two source behaviors here; ten test helpers in store/test.
export interface Helper {
  h: number;
}

export function makeHelper(): Helper {
  return { h: 0 };
}

export function readHelper(helper: Helper): number {
  return helper.h;
}
