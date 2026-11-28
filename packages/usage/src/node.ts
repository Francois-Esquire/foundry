import { anthropic } from "./providers/anthropic";
import { openai } from "./providers/openai";
import { createUsage, type Usage, type UsageOptions } from "./usage";

export const createNodeUsage = (options?: UsageOptions): Usage => {
  const instance = createUsage(options);
  instance.use(anthropic);
  instance.use(openai);
  return instance;
};

export const usage: Usage = createNodeUsage();

export type {
  AnthropicDetails,
  AnthropicOptions,
  AnthropicProvider,
} from "./providers/anthropic";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/usage/node public API.
export { anthropic } from "./providers/anthropic";
export type {
  OpenAIDetails,
  OpenAIOptions,
  OpenAIProvider,
} from "./providers/openai";
export { openai } from "./providers/openai";
