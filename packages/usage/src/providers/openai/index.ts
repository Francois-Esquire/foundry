import { createOpenAI, type OpenAIProvider } from "./provider";

export type { OpenAIDetails } from "./limits";
export type {
  OpenAICredential,
  OpenAIOptions,
  OpenAIProvider,
} from "./provider";

export const openai: OpenAIProvider = createOpenAI();
