import { randomUUID } from "node:crypto";

import type { SessionInput, SessionStream } from "../session/events";
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
import type { GatedTurn } from "./turn-gate";
import { createTurnGate } from "./turn-gate";

/** A turn's parts, plus the failure `drive` hands its own source to rethrow. */
type DriverQueuePart = StreamPart | { type: "driver-error"; error: unknown };

export function createDriverSession(
  settings: DriverSessionSettings,
  driver: HarnessTurnDriver
): HarnessSession {
  validateHarnessProfile(settings.profile);
  const sessionId = settings.sessionId || randomUUID();
  const gate = createTurnGate("Harness");
  const lifetime = new AbortController();
  const persistActivity = createHarnessActivityRecorder({
    ...settings,
    harness: driver.id,
    sessionId,
  });
  const recordActivity = async (
    activity: HarnessActivity,
    queue?: EventQueue<DriverQueuePart>
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

  const runTurn = (
    turn: GatedTurn,
    input: SessionInput,
    options: SessionStreamOptions
  ): SessionStream => {
    const { signal } = turn;
    const queue = createEventQueue<DriverQueuePart>();

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
          nativeSessionId:
            mapping?.type === "harness_session"
              ? mapping.nativeSessionId
              : undefined,
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
          permission: withParentActivity(
            createHarnessPermission({
              ...settings,
              onApprovalRequest: async (request) => {
                await settings.onApprovalRequest?.(request);
                const {
                  approvalMode: _approvalMode,
                  sessionId: _sessionId,
                  ...approval
                } = request;
                queue.push({ ...approval, type: "harness-approval-request" });
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
                      activityId: request.activityId,
                      answerCount,
                      harness: driver.id,
                      outcome,
                      questionCount: request.questions.length,
                      toolCallId: request.toolCallId,
                      type: "harness_question",
                    },
                  ],
                  role: "system",
                  sessionId,
                });
              },
              sessionId,
              signal: () =>
                turn.isActive()
                  ? AbortSignal.any([signal, lifetime.signal])
                  : lifetime.signal,
            }),
            settings.parentActivityId
          ),
          sessionId,
          signal,
          tools: settings.tools,
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
    return result;
  };
  const stream = (input: SessionInput, options: SessionStreamOptions = {}) =>
    gate.run(options.signal, (turn) => runTurn(turn, input, options));

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
      lifetime.abort(new Error("Harness session closed."));
      const terminal = gate.close();
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
      gate.interrupt();
      await driver.interrupt?.();
    },
    route: settings.model,
    sessionId,
    async steer(input) {
      if (!(driver.capabilities.steering && driver.steer)) {
        throw new Error(`${driver.id} does not support steering.`);
      }
      if (!gate.active) {
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
  queue: EventQueue<DriverQueuePart>
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
