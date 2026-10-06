import type { HarnessActivity } from "@foundry/agents/harness";
import { type DriverRun, record } from "./shared";

type ActivityStatus = HarnessActivity["status"];

const CLAUDE_TASK_STATUS: Record<string, ActivityStatus> = {
  completed: "complete",
  failed: "failed",
  killed: "cancelled",
  paused: "waiting",
  pending: "waiting",
  running: "running",
  stopped: "cancelled",
};

const CODEX_AGENT_STATUS: Record<string, ActivityStatus> = {
  completed: "complete",
  errored: "failed",
  interrupted: "waiting",
  notFound: "unknown",
  pendingInit: "waiting",
  running: "running",
  shutdown: "cancelled",
};

const CODEX_TURN_STATUS: Record<string, ActivityStatus> = {
  completed: "complete",
  failed: "failed",
  inProgress: "running",
  interrupted: "waiting",
};

export type NativeActivities = ReturnType<typeof createNativeActivities>;

/** IDs belong to a CLI process, not a resumable transcript. */
export function createNativeActivities(
  initialRun: DriverRun,
  generation: string
) {
  let run = initialRun;
  let closed = false;
  const activities = new Map<string, HarnessActivity>();
  const id = (nativeId: string) => JSON.stringify([generation, nativeId]);
  const publish = async (
    nativeId: string,
    update: Partial<HarnessActivity>
  ) => {
    const activity: HarnessActivity = {
      id: id(nativeId),
      kind: "task",
      lifetime: "session",
      nativeId,
      status: "unknown",
      title: "Native task",
      ...activities.get(nativeId),
      ...update,
    };
    if (closed) {
      activity.actions = [];
      if (activity.status === "running" || activity.status === "waiting") {
        activity.status = "unknown";
      }
    }
    activities.set(nativeId, activity);
    await run.onActivity(activity);
  };
  const claudeAgentResult = async (data: Record<string, unknown>) => {
    const output = record(data.tool_response);
    if (
      !["Agent", "Task"].includes(String(data.tool_name)) ||
      typeof output.agentId !== "string"
    ) {
      return;
    }
    if (!["completed", "async_launched"].includes(String(output.status))) {
      return;
    }
    await publish(output.agentId, {
      kind: "subagent",
      status: output.status === "completed" ? "complete" : "running",
      ...(output.status === "completed" ? { actions: [] } : {}),
      ...(typeof output.agentType === "string"
        ? { title: output.agentType }
        : {}),
      ...(typeof data.agent_id === "string"
        ? { parentId: id(data.agent_id) }
        : {}),
    });
  };
  return {
    async claudeHook(data: Record<string, unknown>) {
      await this.claudeSchedules(data);
      if (typeof data.agent_id !== "string") {
        return;
      }
      await publish(data.agent_id, {
        kind: "subagent",
        // Stop hooks run before the agent stops, and can cause it to continue.
        status:
          data.hook_event_name === "SubagentStart" ? "running" : "unknown",
        title:
          typeof data.agent_type === "string" ? data.agent_type : "Subagent",
      });
    },
    async claudeMessage(data: Record<string, unknown>) {
      if (data.type !== "system" || typeof data.task_id !== "string") {
        return;
      }
      const patch = record(data.patch);
      if (
        ![
          "task_started",
          "task_progress",
          "task_notification",
          "task_updated",
        ].includes(String(data.subtype))
      ) {
        return;
      }
      const nativeStatus =
        data.subtype === "task_updated" ? patch.status : data.status;
      const description = data.description ?? patch.description;
      let status = activities.get(data.task_id)?.status ?? "unknown";
      if (typeof nativeStatus === "string") {
        status = activityStatus(nativeStatus, CLAUDE_TASK_STATUS);
      } else if (
        data.subtype === "task_started" ||
        data.subtype === "task_progress"
      ) {
        status = "running";
      }
      await publish(data.task_id, {
        actions: status === "running" || status === "waiting" ? ["stop"] : [],
        ...claudeDescription(data.subagent_type, description, data.summary),
        status,
      });
    },
    async claudeSchedules(data: Record<string, unknown>) {
      if (!Array.isArray(data.session_crons)) {
        return;
      }
      for (const value of data.session_crons) {
        const cron = record(value);
        if (typeof cron.id !== "string" || typeof cron.schedule !== "string") {
          continue;
        }
        await publish(`cron:${cron.id}`, {
          kind: "schedule",
          nativeId: cron.id,
          status: "waiting",
          summary:
            cron.recurring === true
              ? "Recurring native session schedule"
              : "Native session wakeup",
          title: cron.schedule,
        });
      }
    },
    async claudeTool(data: Record<string, unknown>) {
      await claudeAgentResult(data);
      const output = record(data.tool_response);
      const input = record(data.tool_input);
      if (data.tool_name === "Monitor" && typeof output.taskId === "string") {
        await publish(output.taskId, {
          actions: ["stop"],
          kind: "watch",
          status: "running",
          title:
            typeof input.description === "string"
              ? input.description
              : "Native monitor",
        });
      }
      if (data.tool_name === "CronCreate" && typeof output.id === "string") {
        await publish(`cron:${output.id}`, {
          kind: "schedule",
          lifetime: output.durable === true ? "sandbox" : "session",
          nativeId: output.id,
          status: "waiting",
          title:
            typeof output.humanSchedule === "string"
              ? output.humanSchedule
              : "Native schedule",
        });
      }
      if (data.tool_name === "CronDelete" && typeof output.id === "string") {
        await publish(`cron:${output.id}`, {
          kind: "schedule",
          nativeId: output.id,
          status: "cancelled",
          title: "Deleted native schedule",
        });
      }
    },
    async close() {
      closed = true;
      for (const [nativeKey, activity] of activities) {
        if (
          activity.status === "running" ||
          activity.status === "waiting" ||
          activity.actions?.length
        ) {
          await publish(nativeKey, {
            actions: [],
            status:
              activity.status === "running" || activity.status === "waiting"
                ? "unknown"
                : activity.status,
          });
        }
      }
    },
    async codexItem(item: Record<string, unknown>) {
      if (item.type !== "collabAgentToolCall") {
        return [];
      }
      const states = record(item.agentsStates);
      const receivers = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds
        : [];
      const children = new Set([...receivers, ...Object.keys(states)]);
      const parentId =
        item.tool === "spawnAgent" &&
        typeof item.senderThreadId === "string" &&
        activities.has(item.senderThreadId)
          ? id(item.senderThreadId)
          : undefined;
      const ids: string[] = [];
      for (const child of children) {
        if (typeof child !== "string") {
          continue;
        }
        const state = record(states[child]);
        await publish(child, {
          kind: "subagent",
          ...(parentId ? { parentId } : {}),
          ...codexState(state),
          title: "Codex subagent",
        });
        if (canObserveCodexChild(state.status)) {
          ids.push(child);
        }
      }
      return ids;
    },
    async codexTurn(threadId: string, status: unknown, controllable = false) {
      await publish(threadId, {
        actions: controllable && status === "inProgress" ? ["stop"] : [],
        kind: "subagent",
        status: activityStatus(status, CODEX_TURN_STATUS),
        title: "Codex subagent",
      });
    },
    id,
    setRun(value: DriverRun) {
      run = value;
    },
    taskId(activityId: string) {
      if (closed) {
        return;
      }
      for (const activity of activities.values()) {
        if (activity.id === activityId && activity.actions?.includes("stop")) {
          return activity.nativeId;
        }
      }
    },
  };
}

function claudeDescription(
  subagentType: unknown,
  title: unknown,
  summary: unknown
): Partial<HarnessActivity> {
  const update: Partial<HarnessActivity> = {};
  if (typeof subagentType === "string") {
    update.kind = "subagent";
  }
  if (typeof title === "string") {
    update.title = title;
  }
  if (typeof summary === "string") {
    update.summary = summary;
  }
  return update;
}

function canObserveCodexChild(status: unknown): boolean {
  return (
    status === undefined || status === "running" || status === "pendingInit"
  );
}

function activityStatus(
  value: unknown,
  statuses: Record<string, ActivityStatus>
): ActivityStatus {
  return typeof value === "string" && Object.hasOwn(statuses, value)
    ? (statuses[value] ?? "unknown")
    : "unknown";
}

function codexState(state: Record<string, unknown>): Partial<HarnessActivity> {
  return {
    status: activityStatus(state.status, CODEX_AGENT_STATUS),
    ...(state.status === "running" ? {} : { actions: [] }),
    ...(typeof state.message === "string" ? { summary: state.message } : {}),
  };
}
