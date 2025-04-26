# Foundry Core Library

This document outlines the architecture and implementation details for Foundry's Core Library component.

## Overview

The Core Library is the central component of Foundry that contains the business logic, orchestrates the interactions between other components, and provides the generative capabilities of the system. It serves as the "brain" of Foundry, coordinating between Consumers, Adapters, and Agents to deliver functionality.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│    Consumers    │◄───►│   Core Library  │◄───►│     Adapters    │
│                 │     │                 │     │                 │
└─────────────────┘     └───────┬─────────┘     └─────────────────┘
                                │
                                ▼
                        ┌─────────────────┐
                        │                 │
                        │      Agents     │
                        │                 │
                        └─────────────────┘
```

## Core Library Responsibilities

The Core Library handles several key responsibilities:

1. **Command Processing**: Processes commands received from Consumers
2. **Workflow Orchestration**: Manages complex workflows across components
3. **Business Logic**: Implements domain-specific rules and processes
4. **Data Transformation**: Converts between internal formats and external representations
5. **Error Handling**: Provides robust error handling and recovery mechanisms
6. **Generative Capabilities**: Coordinates generative AI processes through Agents

## Core Library Architecture

### Command Processor

The Command Processor is responsible for handling commands received from Consumers. It validates, routes, and executes commands, ultimately producing results that are returned to the originating Consumer.

```typescript
interface CommandProcessor {
  // Command Handling
  execute(command: string, args: Record<string, any>): Promise<CommandResult>;
  
  // Command Registration
  registerCommand(name: string, handler: CommandHandler): void;
  hasCommand(name: string): boolean;
  
  // Command Validation
  validateCommand(command: string, args: Record<string, any>): ValidationResult;
}
```

### Workflow Engine

The Workflow Engine manages complex, multi-step processes within Foundry. It orchestrates the execution of workflows, maintains state, and handles transitions between steps.

```typescript
interface WorkflowEngine {
  // Workflow Registration
  registerWorkflow(name: string, definition: WorkflowDefinition): void;
  
  // Workflow Execution
  startWorkflow(name: string, context: WorkflowContext): Promise<WorkflowInstance>;
  resumeWorkflow(instanceId: string, event: WorkflowEvent): Promise<WorkflowInstance>;
  
  // Workflow Status
  getWorkflowInstance(instanceId: string): Promise<WorkflowInstance | null>;
  listActiveWorkflows(): Promise<WorkflowSummary[]>;
}

interface WorkflowDefinition {
  steps: WorkflowStep[];
  transitions: WorkflowTransition[];
  onError?: WorkflowErrorHandler;
}
```

### Service Registry

The Service Registry maintains references to internal services and external components required by the Core Library. It provides dependency injection and service discovery capabilities.

```typescript
interface ServiceRegistry {
  // Component Registration
  registerAdapter(name: string, adapter: Adapter): void;
  registerAgent(name: string, agent: Agent): void;
  
  // Service Registration
  registerService(name: string, service: any): void;
  
  // Service Retrieval
  getAdapter(name: string): Adapter;
  getAgent(name: string): Agent;
  getService<T>(name: string): T;
  
  // Health Checks
  checkHealth(): Promise<HealthStatus>;
}
```

### Task Manager

The Task Manager handles the creation, organization, and tracking of tasks. It uses adapters to persist tasks and provides operations for task manipulation.

```typescript
interface TaskManager {
  // Task Operations
  getTasks(options?: TaskQueryOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(task: TaskInput): Promise<Task>;
  updateTask(id: string, updates: Partial<TaskInput>): Promise<Task>;
  deleteTask(id: string): Promise<boolean>;
  
  // Subtask Operations
  getSubtasks(taskId: string): Promise<Subtask[]>;
  addSubtask(taskId: string, subtask: SubtaskInput): Promise<Subtask>;
  
  // Task Organization
  setTaskStatus(id: string, status: TaskStatus): Promise<Task>;
  linkTasks(sourceId: string, targetId: string, relationship: TaskRelationship): Promise<boolean>;
}
```

### Document Generator

The Document Generator creates various documents such as PRDs, user journeys, and technical specifications. It leverages agents to generate content based on specified inputs.

```typescript
interface DocumentGenerator {
  // Document Generation
  generatePRD(concept: string, options?: PRDOptions): Promise<Document>;
  generateUserJourney(persona: string, scenario: string): Promise<Document>;
  generateTechnicalSpec(requirements: string, options?: TechSpecOptions): Promise<Document>;
  
  // Document Operations
  getDocument(id: string): Promise<Document | null>;
  saveDocument(document: Document): Promise<Document>;
  listDocuments(type: DocumentType): Promise<DocumentSummary[]>;
}
```

## Core Library Implementation

The Core Library is implemented as a modular system with several internal components that work together to provide the overall functionality.

### Main Class

```typescript
class CoreLibrary {
  private commandProcessor: CommandProcessor;
  private workflowEngine: WorkflowEngine;
  private serviceRegistry: ServiceRegistry;
  private taskManager: TaskManager;
  private documentGenerator: DocumentGenerator;
  
  constructor(options: CoreLibraryOptions) {
    this.serviceRegistry = new ServiceRegistryImpl();
    
    // Register provided components
    if (options.adapter) {
      this.serviceRegistry.registerAdapter('default', options.adapter);
    }
    
    if (options.agents) {
      Object.entries(options.agents).forEach(([name, agent]) => {
        this.serviceRegistry.registerAgent(name, agent);
      });
    }
    
    // Initialize internal components
    this.commandProcessor = new CommandProcessorImpl(this.serviceRegistry);
    this.workflowEngine = new WorkflowEngineImpl(this.serviceRegistry);
    this.taskManager = new TaskManagerImpl(this.serviceRegistry);
    this.documentGenerator = new DocumentGeneratorImpl(this.serviceRegistry);
    
    // Register standard commands
    this.registerCommands();
    
    // Register standard workflows
    this.registerWorkflows();
  }
  
  async executeCommand(command: string, args: Record<string, any>): Promise<CommandResult> {
    return this.commandProcessor.execute(command, args);
  }
  
  private registerCommands(): void {
    // Register task management commands
    this.commandProcessor.registerCommand('tasks.list', this.taskManager.getTasks.bind(this.taskManager));
    this.commandProcessor.registerCommand('tasks.get', this.taskManager.getTask.bind(this.taskManager));
    // Additional command registrations...
  }
  
  private registerWorkflows(): void {
    // Register standard workflows
    this.workflowEngine.registerWorkflow('product.create', {
      steps: [
        { name: 'concept', handler: this.documentGenerator.generateConcept.bind(this.documentGenerator) },
        { name: 'userJourney', handler: this.documentGenerator.generateUserJourney.bind(this.documentGenerator) },
        { name: 'prd', handler: this.documentGenerator.generatePRD.bind(this.documentGenerator) },
        { name: 'tasks', handler: this.taskManager.generateTasksFromPRD.bind(this.taskManager) }
      ],
      transitions: [
        { from: 'concept', to: 'userJourney', condition: 'always' },
        { from: 'userJourney', to: 'prd', condition: 'always' },
        { from: 'prd', to: 'tasks', condition: 'always' }
      ]
    });
    // Additional workflow registrations...
  }
}
```

## Data Flow Patterns

The Core Library employs several data flow patterns to manage operations efficiently:

### Command Pattern

Commands are processed through a pipeline:
1. **Validation**: Command and arguments are validated
2. **Authorization**: Command execution is authorized for the requester
3. **Execution**: Command is executed by the appropriate handler
4. **Result Formatting**: Result is formatted as a CommandResult
5. **Response**: Result is returned to the caller

### Workflow Pattern

Workflows follow a state machine model:
1. **Initialization**: Workflow is started with initial context
2. **Step Execution**: Each step is executed in sequence
3. **State Management**: State is maintained between steps
4. **Transitions**: Flow moves between steps based on transition rules
5. **Completion/Error**: Workflow completes successfully or handles errors

## Integration With Components

### Consumer Integration

The Core Library exposes its functionality to Consumers through a simple interface:

```typescript
interface CoreLibraryInterface {
  executeCommand(command: string, args: Record<string, any>): Promise<CommandResult>;
  startWorkflow(name: string, context: Record<string, any>): Promise<WorkflowInstance>;
  getStatus(): Promise<CoreLibraryStatus>;
}
```

### Adapter Integration

The Core Library uses Adapters through the Service Registry:

```typescript
// Example of using an adapter in a component
class TaskManagerImpl implements TaskManager {
  constructor(private serviceRegistry: ServiceRegistry) {}
  
  async getTasks(options?: TaskQueryOptions): Promise<Task[]> {
    const adapter = this.serviceRegistry.getAdapter('default');
    
    // Construct path for tasks directory
    const path = 'tasks';
    
    // List all task files
    const files = await adapter.list(path);
    
    // Read and parse each task file
    const tasks = await Promise.all(
      files
        .filter(file => file.endsWith('.md'))
        .map(async file => {
          const result = await adapter.read(`${path}/${file}`);
          if (!result) return null;
          
          // Parse task content
          return this.parseTaskContent(result.content);
        })
    );
    
    // Filter out nulls and apply query options
    return tasks
      .filter((task): task is Task => task !== null)
      .filter(task => this.matchesQueryOptions(task, options));
  }
  
  // Other implementations...
}
```

### Agent Integration

The Core Library leverages Agents for generative capabilities:

```typescript
// Example of using an agent in a component
class DocumentGeneratorImpl implements DocumentGenerator {
  constructor(private serviceRegistry: ServiceRegistry) {}
  
  async generatePRD(concept: string, options?: PRDOptions): Promise<Document> {
    // Get the generator agent
    const agent = this.serviceRegistry.getAgent('generator');
    
    // Prepare the prompt
    const prompt = this.preparePRDPrompt(concept, options);
    
    // Generate the PRD content
    const content = await agent.generate(prompt, {
      maxTokens: options?.maxTokens || 4000,
      temperature: options?.temperature || 0.7
    });
    
    // Create and format the document
    const document: Document = {
      id: uuidv4(),
      type: 'prd',
      title: options?.title || `PRD for ${concept}`,
      content,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        concept,
        generationOptions: options
      }
    };
    
    // Save the document using the adapter
    const adapter = this.serviceRegistry.getAdapter('default');
    await adapter.write(`documents/prd/${document.id}.md`, content, 'text/markdown');
    
    return document;
  }
  
  // Other implementations...
}
```

## Future Enhancements

1. **Plugin System**: Support for plugins to extend Core Library functionality
2. **Event System**: Robust event handling for cross-component communication
3. **Extensible Command Pipeline**: Allow customization of command processing stages
4. **Complex Workflow Patterns**: Support for parallel execution, conditional branches, and loops
5. **Agent Collaboration Framework**: Advanced coordination between multiple agents
6. **Versioning Support**: Better handling of document and task versions 