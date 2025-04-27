# Foundry Agents Specification

This document outlines the architecture and implementation details for Foundry's agent system.

## Overview

Agents in Foundry are the generative AI components that perform intelligent tasks within the system. They abstract away the complexity of working with different Large Language Models (LLMs) and provide specialized capabilities for various use cases.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Core Library   │◄───►│     Agent       │◄───►│   LLM Provider  │
│                 │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
      Request              Processing             Model Execution
```

## Core Agent Interface

All agents must implement the following core interface:

```typescript
interface Agent {
  // Core Methods
  generate(prompt: string, options?: GenerationOptions): Promise<string>;

  // Context Management
  addContext(content: string, metadata?: ContextMetadata): Promise<string>;
  clearContext(): Promise<void>;

  // Configuration
  configure(options: AgentOptions): Promise<void>;
  getCapabilities(): Promise<AgentCapabilities>;
}
```

### Generation Options

```typescript
interface GenerationOptions {
  // Generation Parameters
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];

  // Processing Flags
  stream?: boolean;
  includeMetadata?: boolean;

  // Format Control
  outputFormat?: "text" | "json" | "markdown";
}
```

### Agent Capabilities

```typescript
interface AgentCapabilities {
  // Model Information
  modelName: string;
  contextWindowSize: number;

  // Supported Features
  supportsStreaming: boolean;
  supportsJsonOutput: boolean;
  supportedOutputFormats: string[];

  // Performance Characteristics
  typicalResponseTime: number;
  costPerRequest: number;
}
```

## Agent Types

Foundry implements several specialized agent types, each designed for specific use cases:

### Generator Agent

The Generator Agent creates structured content based on specifications or requirements.

```typescript
interface GeneratorAgent extends Agent {
  // Specialized Generation Methods
  generateFromTemplate(
    template: string,
    variables: Record<string, any>,
  ): Promise<string>;
  generateStructured<T>(prompt: string, schema: JsonSchema): Promise<T>;

  // Examples: Creating tasks, PRDs, user journeys
  createTasks(description: string, count?: number): Promise<Task[]>;
  createPRD(concept: string): Promise<string>;
  createUserJourney(userStory: string): Promise<UserJourney>;
}
```

### Research Agent

The Research Agent gathers and synthesizes information from various sources.

```typescript
interface ResearchAgent extends Agent {
  // Research Methods
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  synthesize(topic: string, sources?: string[]): Promise<ResearchSynthesis>;

  // Citation Management
  formatCitation(source: SearchResult, style?: CitationStyle): Promise<string>;
  validateFact(statement: string): Promise<FactValidation>;
}
```

### Tool Manager Agent

The Tool Manager Agent designs and implements tools that extend Foundry's functionality.

```typescript
interface ToolManagerAgent extends Agent {
  // Tool Creation
  createTool(specification: string): Promise<Tool>;
  analyzeTool(tool: Tool): Promise<ToolAnalysis>;

  // Integration
  generateIntegrationCode(tool: Tool, targetSystem: string): Promise<string>;
  testTool(tool: Tool, testCases: TestCase[]): Promise<TestResult[]>;
}
```

## Agent Implementation

### Base Agent Class

All agent implementations extend a common base class that handles standard operations:

```typescript
abstract class BaseAgent implements Agent {
  protected model: LLMModel;
  protected context: ContextManager;
  protected options: AgentOptions;

  constructor(options: AgentOptions) {
    this.options = options;
    this.model = this.initializeModel(options.model);
    this.context = new ContextManager(options.contextWindowSize);
  }

  // Core Method Implementation
  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    // Prepare context and prompt
    const fullPrompt = this.context.preparePrompt(prompt);

    // Call the model
    const response = await this.model.complete(fullPrompt, options);

    // Process and return result
    return this.processResponse(response);
  }

  // Abstract methods to be implemented by specific agents
  protected abstract initializeModel(modelOptions: ModelOptions): LLMModel;
  protected abstract processResponse(response: ModelResponse): string;

  // Other shared implementations...
}
```

### Context Management

Agents use a context manager to maintain state across multiple interactions:

```typescript
class ContextManager {
  private contextItems: ContextItem[] = [];
  private contextWindowSize: number;

  constructor(contextWindowSize: number) {
    this.contextWindowSize = contextWindowSize;
  }

  addContext(content: string, metadata?: ContextMetadata): string {
    const id = this.generateId();
    this.contextItems.push({ id, content, metadata });
    this.pruneContextIfNeeded();
    return id;
  }

  preparePrompt(prompt: string): string {
    // Combine context items with the prompt
    const contextText = this.formatContext();
    return `${contextText}\n\n${prompt}`;
  }

  private pruneContextIfNeeded(): void {
    // Remove oldest items if we exceed context window size
    // Implement intelligent pruning strategies
  }

  // Other context management methods...
}
```

## Model Integration

Agents integrate with different LLM providers through model adapters:

```typescript
interface LLMModel {
  complete(prompt: string, options?: GenerationOptions): Promise<ModelResponse>;
  stream(
    prompt: string,
    options?: GenerationOptions,
  ): AsyncIterableIterator<StreamChunk>;
  embeddings(text: string): Promise<number[]>;
}

// Implementation for different providers
class OpenAIModel implements LLMModel {
  constructor(apiKey: string, modelName: string) {
    // Initialize with OpenAI credentials
  }

  async complete(
    prompt: string,
    options?: GenerationOptions,
  ): Promise<ModelResponse> {
    // Call OpenAI API
    return response;
  }

  // Other method implementations...
}

class AnthropicModel implements LLMModel {
  // Similar implementation for Anthropic Claude
}

class LocalModel implements LLMModel {
  // Implementation for locally running models
}
```

## Agent Configuration

Agents can be configured when initializing a Consumer:

```typescript
const foundry = new Foundry({
  agents: {
    generator: new GeneratorAgent({
      model: {
        provider: "openai",
        modelName: "gpt-4",
        apiKey: process.env.OPENAI_API_KEY,
      },
      contextWindowSize: 16000,
    }),
    researcher: new ResearchAgent({
      model: {
        provider: "anthropic",
        modelName: "claude-3-opus",
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
      contextWindowSize: 100000,
      searchProvider: "perplexity",
    }),
  },
});
```

## Usage Examples

### Generating Tasks from a PRD

```typescript
async function generateTasksFromPRD(
  prdContent: string,
  foundry: Foundry,
): Promise<Task[]> {
  // Add the PRD to the generator agent's context
  await foundry.agents.generator.addContext(prdContent, { type: "prd" });

  // Generate tasks
  const tasks = await foundry.agents.generator.createTasks(
    "Create tasks based on the PRD in context",
    { count: 20 },
  );

  return tasks;
}
```

### Creating a New Tool

```typescript
async function createNewTool(
  specification: string,
  foundry: Foundry,
): Promise<Tool> {
  // Generate the tool
  const tool = await foundry.agents.toolManager.createTool(specification);

  // Test the tool
  const testCases = [
    { input: "Sample input 1", expectedOutput: "Expected output 1" },
    { input: "Sample input 2", expectedOutput: "Expected output 2" },
  ];
  const results = await foundry.agents.toolManager.testTool(tool, testCases);

  // Return the tool if tests passed
  if (results.every((r) => r.passed)) {
    return tool;
  } else {
    throw new Error("Tool tests failed");
  }
}
```

## Future Enhancements

1. **Agent Lifecycle Management**: Adding review and revision processes to agent outputs
2. **Memory Management**: Specialized memory systems for different content types
   - Code Base Indexing for navigating and understanding code repositories
   - Structured Data Memory for Figma files, databases, and other structured formats
   - Document Memory for books, articles, and unstructured content
   - Graph-Based Memory for representing complex relationships
3. **Agent Composition**: Ability to chain multiple agents together for complex workflows
4. **Fine-tuning Capabilities**: Tools for fine-tuning models for specific domains
5. **Local Models**: Support for running models locally for offline use and data privacy
