/**
 * `@foundry/usage/providers/anthropic`: Claude Code logins and Anthropic API
 * keys. The package entry registers `anthropic` with `usage.use`.
 */

import { type AnthropicProvider, createAnthropic } from "./provider";

export type { AnthropicDetails } from "./limits";
export type {
  AnthropicApiKey,
  AnthropicCredential,
  AnthropicLogin,
  AnthropicProvider,
} from "./provider";

/** Claude Code logins and Anthropic API keys on this machine. */
export const anthropic: AnthropicProvider = createAnthropic();
