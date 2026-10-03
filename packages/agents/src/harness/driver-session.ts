import { randomUUID } from "node:crypto";

import type { SessionInput, SessionMessage, SessionStream } from "../session";
import {
  createHarnessActivityRecorder,
  isActivityActive,
  reduceHarnessActivities,
} from "./activity";
import type { EventQueue } from "./event-queue";
import { createEventQueue } from "./event-queue";
import { createHarnessPermission, redactHarnessSummary } from "./permission";
import { createHarnessQuestionCallback } from "./question";
import type { SessionStreamOptions } from "./session-harness";
import type { StreamPart } from "./stream-transform";
import { transformStream } from "./stream-transform";
import type {
  DriverSessionSettings,
  HarnessActivity,
  HarnessSession,
  HarnessToolEvent,
  HarnessTurnDriver,
} from "./turn-driver";
import { validateHarnessProfile } from "./turn-driver";

export function createDriverSession(
  settings: DriverSessionSettings,
  driver: HarnessTurnDriver
): HarnessSession {
  validateHarnessProfile(settings.profile);
  const sessionId = settings.sessionId ?? randomUUID();
  let active: AbortController | undefined;
  let activeMessage: Promise<SessionMessage> | undefined;
  let closed = false;
  const lifetime = new AbortController();
  const persistActivity = createHarnessActivityRecorder({
    ...settings,
    harness: driver.id,
    sessionId,
  });
  const recordActivity = async (
    activity: HarnessActivity,
    queue?: EventQueue<StreamPart>
  ) => {
    const event = await persistActivity({
      ...activity,
      ...(activity.parentId === undefined &&
      activity.id !== settings.parentActivityId &&
      settings.parentActivityId !== undefined
        ? { parentId: settings.parentActivityId }
        : {}),
    });
    if (event) {
      queue?.push({ event, type: "harness-activity" });
    }
  };

  const stream = (
    input: SessionInput,
    options: SessionStreamOptions = {}
  ): SessionStream => {
    if (closed) {
      throw new Error("Harness session is closed.");
    }
    if (active) {
      throw new Error("A harness session can run only one turn at a time.");
    }
    const controller = new AbortController();
    active = controller;
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const queue = createEventQueue<StreamPart>();

    const recordTool = async (event: HarnessToolEvent) => {
      const safe = {
        ...event,
        agentId: settings.agentId,
        harness: driver.id,
        inputSummary: redactHarnessSummary(event.inputSummary),
        sessionId,
        ...(event.reason ? { reason: redactHarnessSummary(event.reason) } : {}),
      };
      await settings.store.appendMessage({
        parts: [{ event: safe, type: "harness_tool" }],
        role: "system",
        sessionId,
      });
      settings.onToolEvent?.(safe);
      queue.push({ event: safe, type: "harness-tool" });
    };

    const drive = async () => {
      try {
        signal.throwIfAborted();
        if (!(await settings.store.getSession(sessionId))) {
          await settings.store.createSession({ id: sessionId });
        }
        const history = await settings.store.listMessages(sessionId);
        const mapping = history
          .flatMap((message) => message.parts)
          .reverse()
          .find(
            (part) =>
              part.type === "harness_session" && part.harness === driver.id
          );
        await settings.store.appendMessage({
          parts:
            typeof input === "string"
              ? [{ text: input, type: "text" }]
              : input.parts,
          role: "user",
          sessionId,
        });
        const source = await driver.run({
          input,
          sessionId,
          ...(mapping?.type === "harness_session"
            ? { nativeSessionId: mapping.nativeSessionId }
            : {}),
          permission: withParentActivity(
            createHarnessPermission({
              ...settings,
              onApprovalRequest: async (request) => {
                await settings.onApprovalRequest?.(request);
                queue.push({ ...request, type: "harness-approval-request" });
              },
            }),
            settings.parentActivityId
          ),
          profile: settings.profile,
          question: withParentActivity(
            createHarnessQuestionCallback({
              question: settings.question,
              record: async (request, outcome, answerCount) => {
                await settings.store.appendMessage({
                  parts: [
                    {
                      harness: driver.id,
                      outcome,
                      questionCount: request.questions.length,
                      toolCallId: request.toolCallId,
                      type: "harness_question",
                      ...(request.activityId === undefined
                        ? {}
                        : { activityId: request.activityId }),
                      ...(answerCount === undefined ? {} : { answerCount }),
                    },
                  ],
                  role: "system",
                  sessionId,
                });
              },
              sessionId,
              signal: () =>
                active === controller
                  ? AbortSignal.any([signal, lifetime.signal])
                  : lifetime.signal,
            }),
            settings.parentActivityId
          ),
          signal,
          ...(settings.tools ? { tools: settings.tools } : {}),
          onActivity: (activity) => recordActivity(activity, queue),
          onSessionId: async (nativeSessionId) => {
            await settings.store.appendMessage({
              parts: [
                {
                  harness: driver.id,
                  nativeSessionId,
                  type: "harness_session",
                },
              ],
              role: "system",
              sessionId,
            });
          },
          onToolEvent: recordTool,
        });
        await pumpDriverParts(source, signal, queue);
      } catch (error) {
        // Throw through the normalized source so the final message is marked error.
        queue.push({ error, type: "driver-error" });
      } finally {
        queue.close();
      }
    };
    drive();
    const source: AsyncIterable<StreamPart> = {
      async *[Symbol.asyncIterator]() {
        const iterator = queue.iterator();
        for (
          let next = await iterator.next();
          !next.done;
          next = await iterator.next()
        ) {
          if (next.value.type === "driver-error") {
            throw next.value.error;
          }
          yield next.value;
        }
      },
    };
    const result = transformStream(source, {
      commit: (message) =>
        settings.store.appendMessage({
          metadata: message.metadata,
          parts: message.parts,
          role: "assistant",
          sessionId,
          status: message.status,
        }),
      handlers: options,
      model: settings.model,
    });
    const settled = () => {
      if (active === controller) {
        active = undefined;
        activeMessage = undefined;
      }
    };
    activeMessage = result.message;
    result.message.then(settled, settled);
    return result;
  };

  return {
    capabilities: driver.capabilities,
    ...(driver.stopActivity
      ? {
          stopActivity: async (id: string) => {
            const history = await settings.store.listMessages(sessionId);
            const activity = reduceHarnessActivities(history).find(
              (event) => event.harness === driver.id && event.id === id
            );
            if (
              !(
                activity?.actions?.includes("stop") &&
                isActivityActive(activity)
              )
            ) {
              throw new Error("Activity does not support stopping.");
            }
            await driver.stopActivity?.(id);
          },
        }
      : {}),
    async close() {
      closed = true;
      lifetime.abort(new Error("Harness session closed."));
      const terminal = activeMessage;
      active?.abort(new Error("Harness session closed."));
      try {
        await driver.close?.();
      } finally {
        await terminal;

        const history = await settings.store.listMessages(sessionId);
        for (const activity of reduceHarnessActivities(history).filter(
          (event) => event.harness === driver.id
        )) {
          if (isActivityActive(activity)) {
            await recordActivity({ ...activity, status: "unknown" });
          }
        }
      }
    },
    generate: (input, options) => stream(input, options).message,
    async interrupt() {
      if (!driver.capabilities.interruption) {
        throw new Error(`${driver.id} does not support interruption.`);
      }
      active?.abort(new Error("Harness turn interrupted."));
      await driver.interrupt?.();
    },
    route: settings.model,
    sessionId,
    async steer(input) {
      if (!(driver.capabilities.steering && driver.steer)) {
        throw new Error(`${driver.id} does not support steering.`);
      }
      if (!active) {
        throw new Error("Cannot steer a harness without an active turn.");
      }
      await driver.steer(input);
    },
    store: settings.store,
    stream,
  };
}

async function pumpDriverParts(
  source: AsyncIterable<StreamPart>,
  signal: AbortSignal,
  queue: EventQueue<StreamPart>
): Promise<void> {
  for await (const part of source) {
    signal.throwIfAborted();
    if (part.type === "error") {
      throw part.error;
    }
    queue.push(part);
  }
}

function withParentActivity<Request extends { activityId?: string }, Result>(
  callback: (request: Request) => Promise<Result>,
  parentActivityId?: string
): (request: Request) => Promise<Result> {
  return (request) =>
    callback({
      ...request,
      ...(request.activityId === undefined && parentActivityId !== undefined
        ? { activityId: parentActivityId }
        : {}),
    });
}
