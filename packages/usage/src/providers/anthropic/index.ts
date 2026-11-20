import { type AnthropicProvider, createAnthropic } from "./provider";

export type { AnthropicDetails } from "./limits";
export type {
  AnthropicCredential,
  AnthropicOptions,
  AnthropicProvider,
} from "./provider";

export const anthropic: AnthropicProvider = createAnthropic();
