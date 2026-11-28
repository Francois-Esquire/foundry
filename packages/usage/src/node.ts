import { anthropic } from "./providers/anthropic";
import { openai } from "./providers/openai";
import { createUsage, type Usage } from "./usage";

export const createNodeUsage = (): Usage => {
  const instance = createUsage();
  instance.use(anthropic);
  instance.use(openai);
  return instance;
};

export const usage: Usage = createNodeUsage();

export type {
  AnthropicCredential,
  AnthropicDetails,
  AnthropicOptions,
  AnthropicProvider,
} from "./providers/anthropic";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/usage/node public API.
export { anthropic } from "./providers/anthropic";
export type {
  OpenAICredential,
  OpenAIDetails,
  OpenAIOptions,
  OpenAIProvider,
} from "./providers/openai";
export { openai } from "./providers/openai";
