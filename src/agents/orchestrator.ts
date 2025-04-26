import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { OpenAIModel } from './openai-agent';
import { ClaudeModel } from './claude';

/**
 * Supported AI model types
 */
export type ModelType = 'openai' | 'anthropic';

/**
 * Configuration for routing
 */
export interface RoutingConfig {
  defaultProvider: ModelType;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  openaiModel?: OpenAIModel | string;
  anthropicModel?: ClaudeModel | string;
  useSmartRouting?: boolean;
  routerModel?: {
    provider: ModelType;
    modelName: string;
  };
}

/**
 * Simple orchestrator that routes messages to the appropriate AI model
 */
export async function routeMessage(
  message: string,
  config: RoutingConfig,
  conversationHistory: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }> = []
): Promise<{
  response: string;
  provider: ModelType;
  modelName: string;
  routingReason?: string;
}> {
  // Determine which provider to use
  const { provider, modelName, reason } = await determineProvider(
    message,
    config,
    conversationHistory
  );

  // Get API keys
  const apiKey =
    provider === 'openai' ? config.openaiApiKey : config.anthropicApiKey;

  if (!apiKey) {
    throw new Error(`No API key provided for ${provider}`);
  }

  // Generate response using the appropriate provider
  const { text: response } = await generateText({
    model:
      provider === 'openai'
        ? createOpenAI({ apiKey }).chat(modelName)
        : createAnthropic({ apiKey }).chat(modelName),
    prompt: message,
    messages: conversationHistory,
  });

  return {
    response,
    provider,
    modelName,
    routingReason: reason,
  };
}

/**
 * Determine which provider and model to use for a given message
 */
async function determineProvider(
  message: string,
  config: RoutingConfig,
  conversationHistory: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }> = []
): Promise<{ provider: ModelType; modelName: string; reason: string }> {
  // If smart routing is disabled or no router model is configured, use the default provider
  if (!config.useSmartRouting || !config.routerModel) {
    const provider = config.defaultProvider;
    const modelName =
      provider === 'openai'
        ? config.openaiModel || OpenAIModel.GPT_4_0
        : config.anthropicModel || ClaudeModel.CLAUDE_3_5_SONNET;

    return {
      provider,
      modelName,
      reason: 'Using default provider (smart routing disabled)',
    };
  }

  // Use the router model to determine the best provider
  try {
    const routerApiKey =
      config.routerModel.provider === 'openai'
        ? config.openaiApiKey
        : config.anthropicApiKey;

    if (!routerApiKey) {
      throw new Error(
        `No API key provided for router model (${config.routerModel.provider})`
      );
    }

    const routerModel =
      config.routerModel.provider === 'openai'
        ? createOpenAI({ apiKey: routerApiKey }).chat(
            config.routerModel.modelName
          )
        : createAnthropic({ apiKey: routerApiKey }).chat(
            config.routerModel.modelName
          );

    // Analyze the message content to determine the best provider
    const { object: classification } = await generateObject({
      model: routerModel,
      schema: z.object({
        reasoning: z.string().describe('Explanation for the recommendation'),
        category: z.enum([
          'creative',
          'analytical',
          'technical',
          'conversational',
          'objective',
        ]),
        recommendedProvider: z.enum(['openai', 'anthropic']),
      }),
      prompt: `Classify this user message and recommend which AI provider would be best suited to handle it:

"${message}"

Consider:
1. The nature of the query (creative, analytical, technical, etc.)
2. Complexity and nuance required
3. Factual vs. creative content
4. Any specific strengths of available providers (OpenAI tends to be better at code, Claude at longer contextual understanding)
`,
    });

    const provider = classification.recommendedProvider;
    const modelName =
      provider === 'openai'
        ? config.openaiModel || OpenAIModel.GPT_4_0
        : config.anthropicModel || ClaudeModel.CLAUDE_3_5_SONNET;

    return {
      provider,
      modelName,
      reason: `${classification.category} query: ${classification.reasoning}`,
    };
  } catch (error) {
    console.error('Error in smart routing:', error);

    // Fall back to default provider if smart routing fails
    const provider = config.defaultProvider;
    const modelName =
      provider === 'openai'
        ? config.openaiModel || OpenAIModel.GPT_4_0
        : config.anthropicModel || ClaudeModel.CLAUDE_3_5_SONNET;

    return {
      provider,
      modelName,
      reason: 'Error in smart routing, falling back to default',
    };
  }
}

/**
 * Example usage of the orchestrator
 */
export async function handleQuery(
  query: string,
  openaiApiKey: string,
  anthropicApiKey: string
): Promise<string> {
  const result = await routeMessage(query, {
    defaultProvider: 'openai',
    openaiApiKey,
    anthropicApiKey,
    openaiModel: OpenAIModel.GPT_4_0,
    anthropicModel: ClaudeModel.CLAUDE_3_5_SONNET,
    useSmartRouting: true,
    routerModel: {
      provider: 'openai',
      modelName: OpenAIModel.GPT_4_0,
    },
  });

  console.log(`Routed to: ${result.provider} (${result.modelName})`);
  console.log(`Reason: ${result.routingReason}`);

  return result.response;
}
