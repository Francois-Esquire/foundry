import type { Run, Thread } from "@/model/thread";

const STEP_MS = 1500;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asked(thread: Thread, goal: string): Thread {
  const now = Date.now();
  return {
    ...thread,
    messages: thread.messages.map((message) => ({
      ...message,
      text: message.kind === "goal" ? goal : message.text,
      tools: message.tools.map((tool) => ({ ...tool, startedAt: now })),
    })),
    title: thread.title === "New thread" ? thread.title : goal,
  };
}

export function replay(steps: readonly Thread[]): Run {
  return async (goal, show) => {
    for (const step of steps) {
      show(asked(step, goal));
      await wait(STEP_MS);
    }
  };
}
