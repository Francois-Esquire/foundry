// All behavior in one module.
export interface Local {
  value: number;
}

export function makeLocal(): Local {
  return { value: 0 };
}

export function readLocal(local: Local): number {
  return local.value;
}

export function bumpLocal(local: Local): Local {
  return { value: local.value + 1 };
}
