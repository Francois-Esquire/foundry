import type { Drift } from "@l/store";

export function pickDrift(): Drift {
  return { d: 3 };
}

export function resetDrift(): Drift {
  return { d: 4 };
}
