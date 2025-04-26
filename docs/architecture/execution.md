# Foundry Execution Framework

This document outlines the architecture and implementation details for Foundry's execution framework, including task definition, context management, execution pipeline, and review processes.

## Overview

The Execution Framework in Foundry is responsible for transforming conceptual tasks into concrete implementations. It provides the structure, context, and processes needed to execute tasks effectively while maintaining quality and consistency.

```
┌───────────────┐     ┌──────────────────┐     ┌───────────────┐     ┌───────────────┐
│               │     │                  │     │               │     │               │
│   Task Graph  │────►│  Context Builder │────►│   Execution   │────►│ Review Process │
│               │     │                  │     │               │     │               │
└───────────────┘     └──────────────────┘     └───────────────┘     └───────────────┘
```

## Task Definition and Structure

Tasks in Foundry are more than simple to-do items. They represent fully contextualized units of work with clear connections to both the product vision and the technical implementation details.

### Task Structure

A complete task definition includes:

```typescript
interface Task {
  // Core Identification
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  
  // User-Centered Context
  userJourneyConnections: UserJourneyConnection[];
  emotionalGoals: EmotionalGoal[];
  
  // Implementation Details
  acceptanceCriteria: string[];
  dependencies: TaskDependency[];
  subtasks: Subtask[];
  
  // Technical Context
  technicalContext: TechnicalContext;
  implementationGuidance: string;
  
  // Review & Tracking
  reviews: Review[];
  auditResults: AuditResult[];
  history: TaskHistory[];
}
```

### Technical Context

Each task includes specific technical context that guides its implementation:

```typescript
interface TechnicalContext {
  // Technology Stack
  stack: {
    frontend?: string;        // e.g., "NextJS 14 with App Router"
    backend?: string;         // e.g., "Node.js Express"
    database?: string;        // e.g., "Supabase PostgreSQL"
    auth?: string;            // e.g., "Clerk Authentication"
    state?: string;           // e.g., "Redux Toolkit"
    styling?: string;         // e.g., "Tailwind CSS"
    testing?: string;         // e.g., "Jest + React Testing Library"
    deployment?: string;      // e.g., "Vercel"
  };
  
  // Code Style and Standards
  codeStyle: {
    language: string;         // e.g., "TypeScript"
    standard: string;         // e.g., "AirBnB Style Guide"
    formatter: string;        // e.g., "Prettier"
    linter: string;           // e.g., "ESLint"
  };
  
  // Implementation Locations
  locations: {
    codebase: string;         // e.g., "src/features/auth"
    relevantFiles: string[];  // e.g., ["src/features/auth/AuthForm.tsx"]
    examplePatterns: string[];// e.g., ["src/features/profile/ProfileForm.tsx"]
  };
  
  // Additional Resources
  resources: {
    documentation: string[];  // e.g., ["https://nextjs.org/docs/app"]
    designAssets: string[];   // e.g., ["designs/auth-flow.fig"]
    apiSpecs: string[];       // e.g., ["api-docs/auth-endpoints.md"]
  };
}
```

## Execution Pipeline

The execution pipeline is the process by which tasks are transformed from definitions to implementations. This process is optimized for context efficiency and quality control.

### Context Management

Foundry employs an optimized context management strategy:

1. **Fresh Context Approach**: Each task execution starts with a fresh context rather than accumulating context from an ongoing process. This prevents context pollution and confusion.

2. **Targeted Context Loading**: Only the specific context needed for a task is loaded, reducing token usage and improving execution precision.

3. **Dynamic Context Updates**: Context is updated during execution only when necessary, such as when discovering additional dependencies.

### Task Graph Navigation

The task execution system can navigate the task graph to:

1. **Gather Dependencies**: Automatically collect context from dependency tasks
2. **Identify Related Tasks**: Find tasks that might provide useful implementation patterns
3. **Preserve Consistency**: Ensure consistent implementation across related tasks

### Execution Steps

```
┌───────────────────┐
│                   │
│  Task Selection   │
│                   │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│                   │
│  Context Building │
│                   │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│                   │
│  Implementation   │
│                   │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│                   │
│  Review Process   │
│                   │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│                   │
│  Task Completion  │
│                   │
└───────────────────┘
```

## Preconditions and Context Gathering

Before task execution begins, several preconditions and context-gathering steps are performed.

### Precondition Types

1. **Technical Environment Verification**: Ensuring the necessary technical environment exists
2. **Dependency Completion Check**: Verifying that dependencies are completed
3. **Resource Availability**: Confirming that required resources (APIs, assets) are available
4. **Permission Check**: Confirming that the execution process has the necessary permissions

### External Context Sources

Task execution can leverage external context sources through MCP (Machine Control Protocol) connections:

1. **Technology-Specific MCP Servers**: 
   - Supabase MCP for database schema and API information
   - Convex MCP for backend function details
   - NextJS MCP for file system and routing information

2. **IDE Integration**: 
   - VS Code MCP for code structure and navigation
   - GitHub Copilot MCP for additional implementation guidance

### Future Context Optimization

Foundry plans to implement an advanced memory and context module that will:

1. **Unified Graph Representation**: Maintain a unified graph of tasks, dependencies, and resources
2. **One-Call Context Gathering**: Provide a single API call to gather all relevant context
3. **Progressive Context Loading**: Load additional context only when needed
4. **Context Caching**: Cache frequently used context for faster execution
5. **Cross-Task Learning**: Apply insights from completed tasks to future ones

## Implementation Guidance

Each task includes specific implementation guidance to ensure consistency and quality:

### Code Style Guide

```markdown
# Task Implementation Style Guide

## General Principles
- Follow clean code principles (descriptive names, single responsibility)
- Maintain consistent error handling
- Add comments for complex logic only
- Include appropriate tests

## Frontend Components
- Use named exports
- Implement proper accessibility attributes
- Follow atomic design principles
- Separate business logic from presentation

## API Integration
- Use typed requests/responses
- Implement proper error handling
- Cache responses where appropriate
- Include loading states

## State Management
- Minimize global state
- Use appropriate hooks for local state
- Document state transitions
- Ensure proper cleanup

## Testing Expectations
- Unit tests for logic functions
- Component tests for UI elements
- Integration tests for critical paths
```

### Technical Implementation Map

The task also includes a technical implementation map that shows the "neighborhoods" within the codebase where the work will occur:

```markdown
# Technical Implementation Map

## Primary Work Areas
- src/features/auth/components/LoginForm.tsx
- src/features/auth/hooks/useAuth.ts
- src/features/auth/api/authService.ts

## Related Patterns
- See src/features/profile for similar form patterns
- See src/lib/api for API client patterns
- See src/components/common for UI component library

## Implementation Flow
1. Update the authentication service first
2. Then modify the hook implementation
3. Finally update the form components
4. Add tests for each layer
```

## Post-Processing and Review

After implementation, tasks go through a structured review process.

### Review Pipeline

Each task undergoes a multi-stage review process:

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│                  │     │                  │     │                  │
│   Code Review    │────►│  Design Review   │────►│ Acceptance Check │
│                  │     │                  │     │                  │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

1. **Code Review**: Evaluates code quality, adherence to standards, and technical correctness
2. **Design Review**: Ensures the implementation matches design specifications and user experience goals
3. **Acceptance Criteria Check**: Verifies that all specified acceptance criteria are met

### Additional Audits

Beyond the core review pipeline, tasks can undergo additional audits:

1. **Accessibility Audit**: Checks compliance with accessibility standards (WCAG)
2. **Security Audit**: Evaluates security practices and vulnerabilities
3. **Performance Audit**: Assesses performance metrics and optimization opportunities
4. **Cross-Browser Compatibility**: Verifies functionality across targeted browsers

Unlike the main review pipeline, these audits don't block task completion but may generate technical debt items for future refinement.

### Review Process Integration

The review process is integrated into the task execution flow:

```typescript
interface Review {
  type: 'code' | 'design' | 'acceptance' | 'audit';
  status: 'pending' | 'passed' | 'failed';
  reviewer: string;
  comments: string;
  timestamp: Date;
  changes?: {
    requested: string[];
    implemented: string[];
  }
}
```

Failed reviews return the task to the implementation phase with specific change requests.

## Execution API

The Core Library exposes an Execution API for managing the execution process:

```typescript
interface ExecutionManager {
  // Execution Flow
  prepareTask(taskId: string): Promise<PreparedTask>;
  executeTask(taskId: string, options?: ExecutionOptions): Promise<ExecutionResult>;
  reviewTask(taskId: string, review: ReviewInput): Promise<Task>;
  completeTask(taskId: string): Promise<Task>;
  
  // Context Management
  buildContext(taskId: string): Promise<TaskContext>;
  refreshContext(taskId: string, sections?: string[]): Promise<TaskContext>;
  
  // MCP Integration
  connectMCP(provider: string, connection: MCPConnection): Promise<void>;
  executeMCPQuery(provider: string, query: string): Promise<any>;
}
```

## Implementation Example

Here's how a task might flow through the execution process:

```typescript
// 1. Prepare the task
const preparedTask = await executionManager.prepareTask('TASK-123');

// 2. Build context
const context = await executionManager.buildContext('TASK-123');

// 3. Connect necessary MCP providers
await executionManager.connectMCP('supabase', { 
  endpoint: 'https://supabase-instance.supabase.co',
  key: 'sbp_key',
  schema: ['public', 'auth']
});

// 4. Execute the task
const result = await executionManager.executeTask('TASK-123', {
  implementationStrategy: 'incremental',
  contextStrategy: 'refresh-on-demand'
});

// 5. Submit for review
const codeReview = await executionManager.reviewTask('TASK-123', {
  type: 'code',
  reviewer: 'senior-dev',
  status: 'passed',
  comments: 'Implementation follows the code standards.'
});

const designReview = await executionManager.reviewTask('TASK-123', {
  type: 'design',
  reviewer: 'design-lead',
  status: 'passed',
  comments: 'Implementation matches design specifications.'
});

const acceptanceReview = await executionManager.reviewTask('TASK-123', {
  type: 'acceptance',
  reviewer: 'product-owner',
  status: 'passed',
  comments: 'All acceptance criteria are met.'
});

// 6. Mark task as complete
const completedTask = await executionManager.completeTask('TASK-123');
```

## Future Enhancements

1. **Automated Review Pipeline**: Integrate automated tools for certain aspects of the review process
2. **Learning From Execution**: Build a knowledge base from successful implementations
3. **Predictive Context Building**: Anticipate context needs based on task patterns
4. **Cross-Project Task Patterns**: Leverage similar tasks from other projects
5. **Collaborative Execution**: Support multiple agents working on different subtasks
6. **Interactive Debugging**: Provide interactive debugging during implementation
7. **Integration with CI/CD**: Connect execution process to continuous integration and deployment 