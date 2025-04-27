import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  generateObject,
  generateText,
  type CoreMessage,
  type LanguageModel,
} from 'ai';
import { z } from 'zod';

// Define standard model names
const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20240620';

/**
 * Supported AI model types
 */
export type ModelType = 'openai' | 'anthropic';

/**
 * Configuration for the orchestrator
 */
export interface OrchestratorConfig {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  // Optional: Add specific model names here if defaults aren't sufficient later
  // defaultOpenaiModel?: string;
  // defaultAnthropicModel?: string;
}

// Type for a ready-to-use chat model instance
type ChatModelInstance = LanguageModel; // Use the base LanguageModel type from 'ai'

/**
 * Holds the configured provider instances
 */
interface ProviderInstances {
  default: { type: ModelType; model: ChatModelInstance };
  researcher?: { type: ModelType; model: ChatModelInstance }; // For future use
}

/**
 * Creates and returns configured provider instances based on API keys.
 * Prefers OpenAI as the default if available.
 */
function getProviderInstances(config: OrchestratorConfig): ProviderInstances {
  const providers: Partial<ProviderInstances> = {};

  // Configure default provider (Prefer OpenAI)
  if (config.openaiApiKey) {
    providers.default = {
      type: 'openai',
      model: createOpenAI({ apiKey: config.openaiApiKey }).chat(
        DEFAULT_OPENAI_MODEL
      ),
    };
  } else if (config.anthropicApiKey) {
    providers.default = {
      type: 'anthropic',
      model: createAnthropic({ apiKey: config.anthropicApiKey }).chat(
        DEFAULT_ANTHROPIC_MODEL
      ),
    };
  } else {
    throw new Error(
      'OrchestratorConfig requires at least openaiApiKey or anthropicApiKey.'
    );
  }

  // Configure researcher provider (Example: Use Anthropic if available and not default)
  // We can enable and refine this later if needed.
  // if (config.anthropicApiKey && providers.default.type !== 'anthropic') {
  //   providers.researcher = {
  //     type: 'anthropic',
  //     model: createAnthropic({ apiKey: config.anthropicApiKey }).chat(DEFAULT_ANTHROPIC_MODEL)
  //   };
  // }

  return providers as ProviderInstances; // We ensured 'default' exists
}

/**
 * Simple orchestrator that sends a message to the default AI model provider.
 */
export async function routeMessage(
  message: string,
  config: OrchestratorConfig,
  conversationHistory: CoreMessage[] = [] // Use CoreMessage type from 'ai'
): Promise<{
  response: string;
  provider: ModelType;
}> {
  // 1. Get configured provider instances
  const providers = getProviderInstances(config);

  // 2. Select the provider (Using default for now)
  const selectedProvider = providers.default; // Add logic here later to choose 'researcher' if needed

  // 3. Generate response using the selected provider's model
  const { text: response } = await generateText({
    model: selectedProvider.model,
    prompt: message,
    messages: conversationHistory,
  });

  // 4. Return response and provider type
  return {
    response,
    provider: selectedProvider.type,
  };
}

// Removed determineProvider function as smart routing is eliminated

/**
 * Example usage of the orchestrator
 */
export async function handleQuery(
  query: string,
  openaiApiKey: string,
  anthropicApiKey: string
): Promise<string> {
  // Simplified configuration
  const config: OrchestratorConfig = {
    openaiApiKey,
    anthropicApiKey,
  };

  const result = await routeMessage(query, config);

  console.log(`Routed to default provider: ${result.provider}`);
  // console.log(`Reason: ${result.routingReason}`); // Reason is removed

  return result.response;
}
