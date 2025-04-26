import { v4 as uuidv4 } from 'uuid';
import {
  createAnthropic,
  type AnthropicProvider,
  type AnthropicProviderSettings,
} from '@ai-sdk/anthropic';
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import type {
  Agent,
  AgentOptions,
  AgentCapabilities,
  GenerationOptions,
  ContextMetadata,
} from './agent';

/**
 * Available Anthropic Claude models
 * @reference https://docs.anthropic.com/claude/docs/models-overview
 * @see https://sdk.vercel.ai/docs/foundations/providers-and-models
 */
export enum ClaudeModel {
  CLAUDE_3_5_SONNET = 'claude-3-5-sonnet-20240620',
  CLAUDE_3_7_SONNET = 'claude-3-7-sonnet-20250219',
  CLAUDE_3_7_HAIKU = 'claude-3-7-haiku-20240307',
  CLAUDE_3_OPUS = 'claude-3-opus-20240229',
  CLAUDE_3_SONNET = 'claude-3-sonnet-20240229',
  CLAUDE_3_HAIKU = 'claude-3-haiku-20240307',
}

/**
 * Claude agent configuration options
 */
export interface ClaudeAgentOptions extends AgentOptions {
  provider?: 'anthropic';
  modelName: ClaudeModel | string;
  apiKey: string;
  contextWindowSize?: number;
  defaultMaxTokens?: number;
  defaultTemperature?: number;
}

/**
 * Context item structure for managing agent memory
 */
interface ContextItem {
  id: string;
  content: string;
  metadata?: ContextMetadata;
  timestamp: number;
}

/**
 * Claude agent implementation
 */
export class ClaudeAgent implements Agent {
  private options: ClaudeAgentOptions;
  private contextItems: ContextItem[] = [];
  private anthropic: AnthropicProvider;

  constructor(options: ClaudeAgentOptions) {
    this.options = options;
    this.anthropic = createAnthropic({
      apiKey: this.options.apiKey,
    });
  }

  /**
   * Generate text from a prompt using the configured Claude model
   */
  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    // Combine options with defaults
    const finalOptions = {
      temperature:
        options?.temperature ?? this.options.defaultTemperature ?? 0.7,
      maxTokens: options?.maxTokens ?? this.options.defaultMaxTokens ?? 1000,
      stopSequences: options?.stopSequences,
      stream: options?.stream ?? false,
      outputFormat: options?.outputFormat ?? 'text',
    };

    // Prepare the full prompt with context
    const fullPrompt = this.preparePrompt(prompt);

    try {
      // Use Vercel AI SDK to generate text
      const { text: generatedText } = await generateText({
        model: this.anthropic.chat(this.options.modelName),
        prompt: fullPrompt,
        temperature: finalOptions.temperature,
        maxTokens: finalOptions.maxTokens,
        ...(finalOptions.stopSequences
          ? { stopSequences: finalOptions.stopSequences }
          : {}),
      });

      return generatedText;
    } catch (error) {
      console.error('Error generating text with Claude:', error);
      throw new Error(`Claude generation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Add context for future generation requests
   */
  async addContext(
    content: string,
    metadata?: ContextMetadata
  ): Promise<string> {
    const id = uuidv4();

    this.contextItems.push({
      id,
      content,
      metadata,
      timestamp: Date.now(),
    });

    // Prune context if it exceeds the window size
    this.pruneContextIfNeeded();

    return id;
  }

  /**
   * Clear all context items
   */
  async clearContext(): Promise<void> {
    this.contextItems = [];
  }

  /**
   * Configure the agent with new options
   */
  async configure(options: AgentOptions): Promise<void> {
    if (options.model?.provider === 'anthropic' || !options.model?.provider) {
      this.options = { ...this.options, ...options } as ClaudeAgentOptions;
      this.anthropic = createAnthropic({
        apiKey: this.options.apiKey,
      });
    } else {
      throw new Error('Invalid options for Claude agent');
    }
  }

  /**
   * Get the capabilities of this agent
   */
  async getCapabilities(): Promise<AgentCapabilities> {
    // Define capabilities based on the model
    let contextWindowSize = 100000; // Default to a large context window
    let typicalResponseTime = 3000;

    // Adjust capabilities based on the model
    switch (this.options.modelName) {
      case ClaudeModel.CLAUDE_3_OPUS:
        contextWindowSize = 200000;
        typicalResponseTime = 4000;
        break;
      case ClaudeModel.CLAUDE_3_5_SONNET:
      case ClaudeModel.CLAUDE_3_7_SONNET:
      case ClaudeModel.CLAUDE_3_SONNET:
        contextWindowSize = 180000;
        typicalResponseTime = 3000;
        break;
      case ClaudeModel.CLAUDE_3_7_HAIKU:
      case ClaudeModel.CLAUDE_3_HAIKU:
        contextWindowSize = 150000;
        typicalResponseTime = 2000;
        break;
      default:
        // Use defaults for unknown models
        break;
    }

    return {
      modelName: this.options.modelName,
      contextWindowSize: this.options.contextWindowSize || contextWindowSize,
      supportsStreaming: true,
      supportsJsonOutput: true,
      supportedOutputFormats: ['text', 'json', 'markdown'],
      typicalResponseTime,
      costPerRequest: 0.015, // Simplified cost estimate
    };
  }

  /**
   * Prepare the full prompt combining context and the new prompt
   */
  private preparePrompt(prompt: string): string {
    if (this.contextItems.length === 0) {
      return prompt;
    }

    // Combine context items and the new prompt
    const contextText = this.contextItems
      .map(item => item.content)
      .join('\n\n');

    return `${contextText}\n\n${prompt}`;
  }

  /**
   * Remove oldest items from context if we exceed the context window size
   */
  private pruneContextIfNeeded(): void {
    // This is a simplistic approach that could be improved
    const maxItems = 10; // Arbitrary limit for now

    if (this.contextItems.length > maxItems) {
      // Sort by timestamp (oldest first) and remove excess items
      this.contextItems.sort((a, b) => a.timestamp - b.timestamp);
      this.contextItems = this.contextItems.slice(
        this.contextItems.length - maxItems
      );
    }
  }
}

export async function handleCustomerQuery(query: string) {
  const model = createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  }).chat('claude-3-5-sonnet-20240620');

  // First step: Classify the query type
  const { object: classification } = await generateObject({
    model,
    schema: z.object({
      reasoning: z.string(),
      type: z.enum(['general', 'refund', 'technical']),
      complexity: z.enum(['simple', 'complex']),
    }),
    prompt: `Classify this customer query:
    ${query}

    Determine:
    1. Query type (general, refund, or technical)
    2. Complexity (simple or complex)
    3. Brief reasoning for classification`,
  });

  // Route based on classification
  // Set model and system prompt based on query type and complexity
  const anthropicClient = createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  });

  const { text: response } = await generateText({
    model:
      classification.complexity === 'simple'
        ? anthropicClient.chat('claude-3-7-haiku-20240307')
        : anthropicClient.chat('claude-3-7-sonnet-20250219'),
    system: {
      general:
        'You are an expert customer service agent handling general inquiries.',
      refund:
        'You are a customer service agent specializing in refund requests. Follow company policy and collect necessary information.',
      technical:
        'You are a technical support specialist with deep product knowledge. Focus on clear step-by-step troubleshooting.',
    }[classification.type],
    prompt: query,
  });

  return { response, classification };
}
