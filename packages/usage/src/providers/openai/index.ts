/**
 * `@foundry/usage/providers/openai`: Codex logins and OpenAI API keys. The
 * package entry registers `openai` with `usage.use`.
 */

import { createOpenAI, type OpenAIProvider } from "./provider";

export type { OpenAIDetails } from "./limits";
export type {
  OpenAICredential,
  OpenAIOptions,
  OpenAIProvider,
} from "./provider";

/** Codex logins and OpenAI API keys on this machine. */
export const openai: OpenAIProvider = createOpenAI();
