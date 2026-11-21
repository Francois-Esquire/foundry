import type { Health } from "@/model/sprite";
import type { Thread } from "@/model/thread";
import { hasFailed } from "@/model/thread";

const RESTING: Record<Health, string> = {
  battered: "running on fumes",
  critical: "context almost gone",
  fresh: "ready when you are",
  hurt: "feeling the weight",
  scuffed: "holding steady",
};

const WORKING: Record<Health, string> = {
  battered: "nearly out of room",
  critical: "last few tokens",
  fresh: "on it",
  hurt: "pushing through",
  scuffed: "working the list",
};

export function quipFor(thread: Thread, health: Health): string {
  if (hasFailed(thread) && thread.phase === "idle") {
    return "that one got away";
  }
  if (thread.phase === "planning") {
    return "sizing it up";
  }
  return (thread.phase === "working" ? WORKING : RESTING)[health];
}
