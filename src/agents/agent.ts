// Define the generation options for agents
export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  stream?: boolean;
  includeMetadata?: boolean;
  outputFormat?: 'text' | 'json' | 'markdown';
}

// Define the agent capabilities interface
export interface AgentCapabilities {
  modelName: string;
  contextWindowSize: number;
  supportsStreaming: boolean;
  supportsJsonOutput: boolean;
  supportedOutputFormats: string[];
  typicalResponseTime: number;
  costPerRequest: number;
}

// Define the agent configuration options
export interface AgentOptions {
  model: {
    provider: string;
    modelName: string;
    apiKey: string;
  };
  contextWindowSize?: number;
}

// Define context metadata interface
export interface ContextMetadata {
  type?: string;
  source?: string;
  timestamp?: number;
  [key: string]: any;
}

// Core Agent Interface
export interface Agent {
  // Core Methods
  generate(prompt: string, options?: GenerationOptions): Promise<string>;

  // Context Management
  addContext(content: string, metadata?: ContextMetadata): Promise<string>;
  clearContext(): Promise<void>;

  // Configuration
  configure(options: AgentOptions): Promise<void>;
  getCapabilities(): Promise<AgentCapabilities>;
}
