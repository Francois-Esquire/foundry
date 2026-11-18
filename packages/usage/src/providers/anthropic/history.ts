import { basename, join } from "node:path";

import { quantities, type Work } from "../../consumption";
import { historyFiles, jsonLines, mapLimit } from "../local";
import { count, record, text } from "../values";

const SYNTHETIC_MODEL = "<synthetic>";
const USAGE_MARKER = '"usage"';

const workOf = (
  value: unknown,
  file: string
): { key?: string; work: Work } | undefined => {
  const line = record(value);
  const message = record(line.message);
  const usage = record(message.usage);
  const model = text(message.model);
  const at = Date.parse(String(line.timestamp));
  if (
    line.type !== "assistant" ||
    !message.usage ||
    !model ||
    model === SYNTHETIC_MODEL ||
    Number.isNaN(at)
  ) {
    return;
  }
  const messageId = text(message.id);
  const requestId = text(line.requestId);
  return {
    ...(messageId || requestId
      ? { key: `${messageId ?? ""}:${requestId ?? ""}` }
      : {}),
    work: {
      at,
      model,
      quantities: quantities({
        cachedInputTokens: count(usage.cache_read_input_tokens),
        cacheWriteTokens: count(usage.cache_creation_input_tokens),
        inputTokens: count(usage.input_tokens),
        outputTokens: count(usage.output_tokens),
        reasoningTokens: count(
          record(usage.output_tokens_details).thinking_tokens
        ),
      }),
      session: text(line.sessionId) ?? basename(file, ".jsonl"),
      standardSpeed: usage.speed !== "fast",
    },
  };
};

export const readClaudeHistory = async (
  configDir: string,
  since: Date
): Promise<Work[]> => {
  const files = await historyFiles([join(configDir, "projects")], since);
  const perFile = await mapLimit(files, async (file) => {
    const found: { key?: string; work: Work }[] = [];
    for await (const value of jsonLines(file, [USAGE_MARKER])) {
      const entry = workOf(value, file);
      if (entry) {
        found.push(entry);
      }
    }
    return found;
  });
  const seen = new Set<string>();
  const works: Work[] = [];
  for (const { key, work } of perFile.flat()) {
    if (key !== undefined) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    if (work.at >= since.getTime()) {
      works.push(work);
    }
  }
  return works;
};
