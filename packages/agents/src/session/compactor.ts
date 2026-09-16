import type { LanguageModel, ModelMessage } from "ai";

import { generateText, pruneMessages } from "ai";

import type { TokenCounter } from "../contexts/types";
import { toModelMessages } from "./converter";
import { stringifyValue } from "./serialize";
import type { SummarizableStore, SummarizeResult } from "./store";
import { foldSet } from "./store";
import type { SessionMessage } from "./types";

type ModelMessagePart = Exclude<ModelMessage["content"], string>[number];

export interface Summarizer {
  summarize(messages: SessionMessage[]): Promise<string>;
}

export interface ModelSummarizerOptions {
  instruction?: string;
  maxOutputTokens?: number;
  model: LanguageModel;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

const DEFAULT_INSTRUCTION = [
  "Compress a segment of a conversation into a concise, factual summary.",
  "Preserve decisions made, concrete facts, open questions, and any state that",
  "later turns rely on. Drop pleasantries and redundancy. Write plain prose,",
  "third person, no preamble or sign-off.",
].join(" ");

export function createModelSummarizer(
  opts: ModelSummarizerOptions
): Summarizer {
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const instruction = opts.instruction ?? DEFAULT_INSTRUCTION;
  return {
    async summarize(messages: SessionMessage[]): Promise<string> {
      const { text } = await generateText({
        maxOutputTokens,
        model: opts.model,
        prompt: await renderTranscript(messages),
        system: instruction,
      });
      return text.trim();
    },
  };
}

export async function renderTranscript(
  messages: SessionMessage[]
): Promise<string> {
  const pruned = pruneMessages({
    emptyMessages: "remove",
    messages: await toModelMessages(messages),
    reasoning: "all",
  });
  return pruned.map(renderMessage).join("\n\n");
}

function renderMessage(message: ModelMessage): string {
  const body =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map(renderPart)
          .filter((line) => line.length > 0)
          .join("\n");
  return `[${message.role}]\n${body}`;
}

function renderPart(part: ModelMessagePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "tool-call":
      return `(tool_call ${part.toolName}) ${stringifyValue(part.input)}`;
    case "tool-result":
      return `(tool_result) ${stringifyValue(part.output)}`;
    case "reasoning":
    case "reasoning-file":
    case "custom":
    case "file":
    case "image":
    case "tool-approval-request":
    case "tool-approval-response":
      return "";
  }
}

/**
 * Summarize the messages before `messageId` and fold them via the store's own
 * primitive. No-op (`null`) when there's nothing to fold.
 */
export async function compact(
  store: SummarizableStore,
  summarizer: Summarizer,
  sessionId: string,
  messageId: string
): Promise<SummarizeResult | null> {
  const history = await store.listMessages(sessionId);
  const fold = foldSet(history, messageId);
  if (fold.length === 0) {
    return null;
  }

  const text = await summarizer.summarize(fold);
  return store.summarize({
    messageId,
    sessionId,
    summary: { parts: [{ text, type: "text" }] },
  });
}

/**
 * When to compact and how much to keep. Token math is injected as plain values
 * (not a contexts dependency) so this stays free of the sizing subsystem.
 */
export interface CompactionOptions {
  /** Counts the token cost of one message — the package's canonical counter contract. */
  counter: TokenCounter;
  /** Tokens of recent tail to keep unfolded. */
  keepTokens: number;
  /** Effective token ceiling: compact when the active context exceeds it. */
  limit: number;
}

/**
 * Compact the session iff its active context exceeds `limit`. Picks a marker that
 * keeps roughly `keepTokens` of recent history, then folds everything before it.
 * No-op (`null`) when under budget or there's no clean boundary to fold at.
 */
export async function maybeCompact(
  store: SummarizableStore,
  summarizer: Summarizer,
  sessionId: string,
  opts: CompactionOptions
): Promise<SummarizeResult | null> {
  const active = await store.activeMessages(sessionId);
  if (contextTokens(active, opts.counter) <= opts.limit) {
    return null;
  }

  const markerId = selectMarker(active, opts.keepTokens, opts.counter);
  if (!markerId) {
    return null;
  }

  return compact(store, summarizer, sessionId, markerId);
}

/**
 * Current context size. Prefers the last reported actual usage (ground truth,
 * includes the system prompt); falls back to the heuristic counter before any
 * turn has reported usage.
 */
function contextTokens(
  messages: SessionMessage[],
  counter: TokenCounter
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]?.metadata?.usage;
    if (usage) {
      return usage.inputTokens + usage.outputTokens;
    }
  }
  let total = 0;
  for (const m of messages) {
    total += counter.count(m);
  }
  return total;
}

/**
 * The fold marker: the oldest message to keep, snapped forward to a `user`
 * message so a kept turn never starts mid tool-call/result pair. Walks back from
 * the end accumulating `keepTokens`, then finds the next turn boundary. Returns
 * `undefined` when there's nothing before it to fold.
 */
export function selectMarker(
  messages: SessionMessage[],
  keepTokens: number,
  counter: TokenCounter
): string | undefined {
  let kept = 0;
  let boundary = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) {
      continue;
    }
    kept += counter.count(m);
    boundary = i;
    if (kept >= keepTokens) {
      break;
    }
  }

  let markerIndex: number | undefined;
  for (let i = boundary; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex === undefined) {
    return undefined;
  }

  markerIndex = protectUnresolvedApprovals(messages, markerIndex);
  return markerIndex > 0 ? messages[markerIndex]?.id : undefined;
}

/**
 * Pull the marker back to before any unresolved `tool_approval_request` it
 * would otherwise fold away. Folding turns a message's parts into summary
 * prose, which would destroy the exact `approvalId`/`toolCallId` identity a
 * later `tool_approval_response` needs to resolve against — so a request
 * with no matching response anywhere in `messages` must stay in the active
 * (unfolded) tail no matter the token budget.
 */
function protectUnresolvedApprovals(
  messages: SessionMessage[],
  markerIndex: number
): number {
  const resolvedApprovalIds = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool_approval_response") {
        resolvedApprovalIds.add(p.approvalId);
      }
    }
  }

  for (let i = 0; i < markerIndex; i++) {
    const m = messages[i];
    if (!m) {
      continue;
    }
    const hasUnresolved = m.parts.some(
      (p) =>
        p.type === "tool_approval_request" &&
        !resolvedApprovalIds.has(p.approvalId)
    );
    if (hasUnresolved) {
      return i;
    }
  }
  return markerIndex;
}
