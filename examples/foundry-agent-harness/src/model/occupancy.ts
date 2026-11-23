import { HEALTH, type Health } from "@/model/sprite";
import type { Step } from "@/model/thread";

export interface Occupancy {
  readonly health: Health;
  readonly left: number;
  readonly tokens: number;
  readonly used: number;
}

const REMAINING = [0.8, 0.6, 0.4, 0.2];

function estimate(step: Step | undefined): number {
  if (!step?.usage) {
    return 0;
  }
  return (
    Math.round(step.usage.input / (step.tools.length + 1)) + step.usage.output
  );
}

function healthAt(used: number): Health {
  const index = REMAINING.findIndex((floor) => 1 - used >= floor);
  return HEALTH[index < 0 ? HEALTH.length - 1 : index] ?? "critical";
}

export function occupancyOf(steps: readonly Step[], limit: number): Occupancy {
  const tokens = estimate(steps.findLast((step) => step.usage !== null));
  const used = limit > 0 ? Math.min(Math.max(tokens / limit, 0), 1) : 0;
  return {
    health: healthAt(used),
    left: Math.max(limit - tokens, 0),
    tokens,
    used,
  };
}
