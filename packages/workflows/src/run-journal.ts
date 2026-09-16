import { Schema } from "effect";
import { InvalidRunFrameSequenceError } from "./errors";
import type { JsonValue, RunFrame, RunFramePayload } from "./execution-records";
import { RunFrameSchema } from "./execution-records";
import type { Page, PageQuery } from "./execution-repository";

export interface AppendRunFrameInput {
  at?: number;
  payload: RunFramePayload;
  runId: string;
}

export interface ClaimRunEffectInput {
  at?: number;
  key: string;
  metadata?: JsonValue;
  runId: string;
}

export interface RunFramePageQuery extends PageQuery {
  after?: number;
  runId?: string;
}

export interface FrameRun {
  lastAt: number;
  runId: string;
}

/** Ordered, retained observation for one Run. */
export interface RunJournal {
  appendRunFrame(input: AppendRunFrameInput): Promise<RunFrame>;
  /**
   * Atomically append one durable effect-claim marker per `(runId, key)`.
   * Returns the appended frame for the winner and null for every duplicate.
   */
  claimRunEffect(input: ClaimRunEffectInput): Promise<RunFrame | null>;
  countFrameRuns(): Promise<number>;
  countFrames(
    query?: Pick<RunFramePageQuery, "runId" | "after">
  ): Promise<number>;
  deleteRunFrames(runId: string): Promise<void>;
  listFrameRuns(query?: PageQuery): Promise<Page<FrameRun>>;
  listFrames(query?: RunFramePageQuery): Promise<Page<RunFrame>>;
  listRunFrames(runId: string, after?: number): Promise<RunFrame[]>;
}

export const RUN_EFFECT_CLAIM_EVENT = "run-effect-claimed";

/** Receipts and named claims may outlive execution; live activity may not. */
export function isPostTerminalRunEvidence(payload: JsonValue): boolean {
  if (typeof payload !== "object" || payload === null || !("kind" in payload)) {
    return false;
  }
  if (payload.kind === "output") {
    return true;
  }
  if (
    payload.kind !== "log" ||
    !("value" in payload) ||
    typeof payload.value !== "object" ||
    payload.value === null ||
    !("event" in payload.value) ||
    !("key" in payload.value)
  ) {
    return false;
  }
  const value = payload.value;
  return (
    value.event === RUN_EFFECT_CLAIM_EVENT &&
    typeof value.key === "string" &&
    value.key.trim().length > 0
  );
}

export function runEffectClaimPayload(
  input: Pick<ClaimRunEffectInput, "key" | "metadata">
): RunFramePayload {
  if (input.key.trim().length === 0) {
    throw new Error("Run effect claim key cannot be empty");
  }
  return {
    kind: "log",
    value: {
      event: RUN_EFFECT_CLAIM_EVENT,
      key: input.key,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  };
}

export function isRunEffectClaim(frame: RunFrame, key: string): boolean {
  if (frame.payload.kind !== "log") {
    return false;
  }
  const value = frame.payload.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return record.event === RUN_EFFECT_CLAIM_EVENT && record.key === key;
}

/** The single canonical decoder used before persistence and after hydration. */
export function decodeRunFrame(value: unknown): RunFrame {
  return Schema.decodeUnknownSync(RunFrameSchema)(value);
}

export function decodeRunFrames(values: readonly unknown[]): RunFrame[] {
  return values.map(decodeRunFrame);
}

/** Decode and validate one persisted Run's complete retained frame sequence. */
export function decodeRunFrameSequence(
  runId: string,
  values: readonly unknown[]
): RunFrame[] {
  const frames = decodeRunFrames(values);
  let terminalCursor: number | null = null;
  for (const [index, frame] of frames.entries()) {
    if (frame.runId !== runId) {
      throw new InvalidRunFrameSequenceError(
        runId,
        `frame ${index} belongs to ${frame.runId}`
      );
    }
    if (frame.cursor !== index) {
      throw new InvalidRunFrameSequenceError(
        runId,
        `cursor ${frame.cursor} is out of order; expected ${index}`
      );
    }
    if (!isTerminalFrame(frame)) {
      if (
        terminalCursor !== null &&
        !isPostTerminalRunEvidence(frame.payload)
      ) {
        throw new InvalidRunFrameSequenceError(
          runId,
          `activity at cursor ${frame.cursor} follows terminal cursor ${terminalCursor}`
        );
      }
      continue;
    }
    if (terminalCursor !== null) {
      throw new InvalidRunFrameSequenceError(
        runId,
        `terminal cursors ${terminalCursor} and ${frame.cursor} both exist`
      );
    }
    terminalCursor = frame.cursor;
  }
  return frames;
}

function isTerminalFrame(frame: RunFrame): boolean {
  if (frame.payload.kind !== "lifecycle") {
    return false;
  }
  const value = frame.payload.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const event = (value as Readonly<Record<string, unknown>>).event;
  return event === "complete" || event === "failed" || event === "cancelled";
}
