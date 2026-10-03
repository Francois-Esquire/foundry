import type { SessionMessage } from "../session";
import { redactHarnessSummary } from "./permission";
import type { HarnessActivity, HarnessActivityEvent } from "./turn-driver";

/** Reconstruct without relying on transcript ordering or duplicate delivery. */
export function reduceHarnessActivities(
  messages: readonly SessionMessage[]
): HarnessActivityEvent[] {
  const activities = new Map<string, HarnessActivityEvent>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "harness_activity") {
        continue;
      }
      const { event } = part;
      const key = JSON.stringify([event.sessionId, event.harness, event.id]);
      const previous = activities.get(key);
      if (!previous || event.revision > previous.revision) {
        activities.set(key, event);
      }
    }
  }
  return [...activities.values()];
}

export function isActivityActive(activity: HarnessActivityEvent): boolean {
  return activity.status === "running" || activity.status === "waiting";
}

const activityWrites = new WeakMap<
  import("../session").SessionStore,
  Map<string, Promise<void>>
>();

export function createHarnessActivityRecorder(settings: {
  agentId: string;
  harness: string;
  sessionId: string;
  store: import("../session").SessionStore;
  onActivity?: (event: HarnessActivityEvent) => void | Promise<void>;
}): (activity: HarnessActivity) => Promise<HarnessActivityEvent | undefined> {
  let writes = activityWrites.get(settings.store);
  if (!writes) {
    writes = new Map();
    activityWrites.set(settings.store, writes);
  }
  const key = JSON.stringify([settings.sessionId, settings.harness]);
  const sharedWrites = writes;
  return (activity) => {
    const pending = sharedWrites.get(key) ?? Promise.resolve();
    const write = pending.then(async () => {
      const history = await settings.store.listMessages(settings.sessionId);
      const previous = reduceHarnessActivities(history).find(
        (candidate) =>
          candidate.harness === settings.harness && candidate.id === activity.id
      );
      if (previous && isLateProgress(previous, activity)) {
        return;
      }
      const safe = sanitizeActivity(activity);
      if (previous && sameActivity(previous, safe)) {
        return;
      }
      const event: HarnessActivityEvent = {
        ...safe,
        agentId: settings.agentId,
        harness: settings.harness,
        revision: (previous?.revision ?? 0) + 1,
        sessionId: settings.sessionId,
      };
      await settings.store.appendMessage({
        parts: [{ event, type: "harness_activity" }],
        role: "system",
        sessionId: settings.sessionId,
      });
      await settings.onActivity?.(event);
      return event;
    });
    const settled = write.then(
      () => undefined,
      () => undefined
    );
    sharedWrites.set(key, settled);
    return write;
  };
}

function isLateProgress(
  previous: HarnessActivityEvent,
  activity: HarnessActivity
): boolean {
  return (
    !isActivityActive(previous) &&
    previous.status !== "unknown" &&
    (activity.status === "running" ||
      activity.status === "waiting" ||
      activity.status === "unknown") &&
    activity.kind !== "watch" &&
    activity.kind !== "schedule"
  );
}

function sanitizeActivity(activity: HarnessActivity): HarnessActivity {
  return {
    id: activity.id,
    kind: activity.kind,
    lifetime: activity.lifetime,
    status: activity.status,
    title: redactHarnessSummary(activity.title),
    ...(activity.nativeId === undefined ? {} : { nativeId: activity.nativeId }),
    ...(activity.parentId === undefined ? {} : { parentId: activity.parentId }),
    ...(activity.actions === undefined ? {} : { actions: activity.actions }),
    ...(activity.summary === undefined
      ? {}
      : { summary: redactHarnessSummary(activity.summary) }),
  };
}

function sameActivity(
  previous: HarnessActivityEvent,
  safe: HarnessActivity
): boolean {
  const {
    agentId: _agentId,
    harness: _harness,
    sessionId: _sessionId,
    revision: _revision,
    ...snapshot
  } = previous;
  return (
    Object.entries(safe).every(
      ([key, value]) =>
        JSON.stringify(value) ===
        JSON.stringify(snapshot[key as keyof HarnessActivity])
    ) && Object.keys(snapshot).length === Object.keys(safe).length
  );
}
