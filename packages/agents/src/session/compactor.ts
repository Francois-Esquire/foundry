import type { LanguageModel, ModelMessage } from "ai";

import { generateText, pruneMessages } from "ai";

import type { TokenCounter } from "../contexts/types";
import type { SessionStore } from "../store";
import { toModelMessages } from "./converter";
import { stringifyValue } from "./serialize";
import type { SummarizeResult } from "./sessions";
import { foldSet, Sessions } from "./sessions";
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
    default:
      break;
  }
  return undefined as never;
}

export async function compact(
  store: SessionStore,
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
  const commit = async (
    view: SessionStore
  ): Promise<SummarizeResult | null> => {
    const current = foldSet(await view.listMessages(sessionId), messageId);
    if (!deepStrictEqual(current, fold)) {
      return null;
    }
    return await new Sessions({ store: view }).summarize({
      messageId,
      sessionId,
      summary: { parts: [{ text, type: "text" }] },
    });
  };
  return store.transaction === undefined
    ? commit(store)
    : store.transaction(commit);
}

export interface CompactionOptions {
  counter: TokenCounter;
  keepTokens: number;
  limit: number;
}

export async function maybeCompact(
  store: SessionStore,
  summarizer: Summarizer,
  sessionId: string,
  opts: CompactionOptions
): Promise<SummarizeResult | null> {
  const active = await new Sessions({ store }).activeMessages(sessionId);
  if (contextTokens(active, opts.counter) <= opts.limit) {
    return null;
  }

  const markerId = selectMarker(active, opts.keepTokens, opts.counter);
  if (!markerId) {
    return null;
  }

  return compact(store, summarizer, sessionId, markerId);
}

function contextTokens(
  messages: SessionMessage[],
  counter: TokenCounter
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
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

export function selectMarker(
  messages: SessionMessage[],
  keepTokens: number,
  counter: TokenCounter
): string | undefined {
  let kept = 0;
  let boundary = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
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
  for (let i = boundary; i < messages.length; i += 1) {
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

  for (let i = 0; i < markerIndex; i += 1) {
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

function ownEnumerableKeys(value: object): (string | symbol)[] {
  const symbols = Object.getOwnPropertySymbols(value).filter((symbol) =>
    Object.prototype.propertyIsEnumerable.call(value, symbol)
  );
  return [...Object.keys(value), ...symbols];
}

interface SeenPairs {
  readonly left: Map<object, object>;
  readonly right: Map<object, object>;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

function equalTypedViews(a: ArrayBufferView, b: ArrayBufferView): boolean {
  return equalBytes(
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  );
}

function equalSets(a: Set<unknown>, b: Set<unknown>, seen: SeenPairs): boolean {
  if (a.size !== b.size) {
    return false;
  }
  const bItems = [...b];
  const matched = new Array<boolean>(bItems.length).fill(false);
  for (const itemA of a) {
    let found = false;
    for (let i = 0; i < bItems.length; i += 1) {
      if (!matched[i] && deepStrictEqual(itemA, bItems[i], seen)) {
        matched[i] = true;
        found = true;
        break;
      }
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

function equalMaps(
  a: Map<unknown, unknown>,
  b: Map<unknown, unknown>,
  seen: SeenPairs
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  const bEntries = [...b.entries()];
  const matched = new Array<boolean>(bEntries.length).fill(false);
  for (const [keyA, valueA] of a.entries()) {
    let found = false;
    for (let i = 0; i < bEntries.length; i += 1) {
      const entryB = bEntries[i];
      if (
        !matched[i] &&
        entryB !== undefined &&
        deepStrictEqual(keyA, entryB[0], seen) &&
        deepStrictEqual(valueA, entryB[1], seen)
      ) {
        matched[i] = true;
        found = true;
        break;
      }
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

function equalArrays(
  a: readonly unknown[],
  b: readonly unknown[],
  seen: SeenPairs
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (i in a !== i in b) {
      return false;
    }
    if (!deepStrictEqual(a[i], b[i], seen)) {
      return false;
    }
  }
  return equalOwnProperties(a, b, seen);
}

function equalOwnProperties(a: object, b: object, seen: SeenPairs): boolean {
  const keysA = ownEnumerableKeys(a);
  const keysB = ownEnumerableKeys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  const left = a as Record<string | symbol, unknown>;
  const right = b as Record<string | symbol, unknown>;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) {
      return false;
    }
    if (!deepStrictEqual(left[key], right[key], seen)) {
      return false;
    }
  }
  return true;
}

function equalBuiltinContent(a: object, b: object, seen: SeenPairs): boolean {
  if (a instanceof Date) {
    return b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (a instanceof RegExp) {
    return (
      b instanceof RegExp &&
      a.source === b.source &&
      a.flags === b.flags &&
      a.lastIndex === b.lastIndex
    );
  }
  if (a instanceof ArrayBuffer) {
    return (
      b instanceof ArrayBuffer &&
      equalBytes(new Uint8Array(a), new Uint8Array(b))
    );
  }
  if (ArrayBuffer.isView(a)) {
    return ArrayBuffer.isView(b) && equalTypedViews(a, b);
  }
  if (a instanceof Set) {
    return b instanceof Set && equalSets(a, b, seen);
  }
  if (a instanceof Map) {
    return b instanceof Map && equalMaps(a, b, seen);
  }
  return true;
}

function deepStrictEqual(
  a: unknown,
  b: unknown,
  seen: SeenPairs = { left: new Map(), right: new Map() }
): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return false;
  }
  if (seen.left.has(a) || seen.right.has(b)) {
    return seen.left.get(a) === b && seen.right.get(b) === a;
  }
  seen.left.set(a, b);
  seen.right.set(b, a);
  try {
    if (Array.isArray(a)) {
      return Array.isArray(b) && equalArrays(a, b, seen);
    }
    return equalBuiltinContent(a, b, seen) && equalOwnProperties(a, b, seen);
  } finally {
    seen.left.delete(a);
    seen.right.delete(b);
  }
}
