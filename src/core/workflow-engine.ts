import type { ServiceRegistry } from './registry';
import { v4 as uuidv4 } from 'uuid';

// Workflow step interface
export interface WorkflowStep {
  name: string;
  handler: (context: WorkflowContext) => Promise<any>;
  retry?: {
    maxAttempts: number;
    backoff: number;
  };
}

// Workflow transition interface
export interface WorkflowTransition {
  from: string;
  to: string;
  condition: string | ((result: any) => boolean);
}

// Workflow error handler
export interface WorkflowErrorHandler {
  (error: Error, context: WorkflowContext, step: WorkflowStep): Promise<void>;
}

// Workflow definition
export interface WorkflowDefinition {
  steps: WorkflowStep[];
  transitions: WorkflowTransition[];
  onError?: WorkflowErrorHandler;
}

// Workflow context
export interface WorkflowContext {
  id: string;
  data: Record<string, any>;
  results: Record<string, any>;
  currentStep: string;
  startedAt: Date;
  lastUpdatedAt: Date;
}

// Workflow instance
export interface WorkflowInstance {
  id: string;
  definition: string;
  context: WorkflowContext;
  status: 'running' | 'completed' | 'failed' | 'paused';
  error?: {
    step: string;
    message: string;
    details?: any;
  };
}

// Workflow event
export interface WorkflowEvent {
  type: string;
  data: any;
}

// Workflow summary
export interface WorkflowSummary {
  id: string;
  definition: string;
  currentStep: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  startedAt: Date;
  lastUpdatedAt: Date;
}

// Workflow engine interface
export interface WorkflowEngine {
  // Workflow Registration
  registerWorkflow(name: string, definition: WorkflowDefinition): void;

  // Workflow Execution
  startWorkflow(
    name: string,
    context: WorkflowContext
  ): Promise<WorkflowInstance>;
  resumeWorkflow(
    instanceId: string,
    event: WorkflowEvent
  ): Promise<WorkflowInstance>;

  // Workflow Status
  getWorkflowInstance(instanceId: string): Promise<WorkflowInstance | null>;
  listActiveWorkflows(): Promise<WorkflowSummary[]>;
}

// Workflow engine implementation
export class WorkflowEngineImpl implements WorkflowEngine {
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private instances: Map<string, WorkflowInstance> = new Map();
  private serviceRegistry: ServiceRegistry;

  constructor(serviceRegistry: ServiceRegistry) {
    this.serviceRegistry = serviceRegistry;
  }

  registerWorkflow(name: string, definition: WorkflowDefinition): void {
    this.workflows.set(name, definition);
  }

  async startWorkflow(
    name: string,
    initialData: Record<string, any> = {}
  ): Promise<WorkflowInstance> {
    // Check if workflow exists
    const definition = this.workflows.get(name);
    if (!definition) {
      throw new Error(`Workflow not found: ${name}`);
    }

    // Ensure the workflow has at least one step
    if (!definition.steps || definition.steps.length === 0) {
      throw new Error(`Workflow has no steps: ${name}`);
    }

    // Create workflow context
    const context: WorkflowContext = {
      id: uuidv4(),
      data: initialData,
      results: {},
      currentStep: definition.steps[0]!.name,
      startedAt: new Date(),
      lastUpdatedAt: new Date(),
    };

    // Create workflow instance
    const instance: WorkflowInstance = {
      id: context.id,
      definition: name,
      context,
      status: 'running',
    };

    // Store instance
    this.instances.set(instance.id, instance);

    // Execute first step
    return this.executeStep(instance);
  }

  async resumeWorkflow(
    instanceId: string,
    event: WorkflowEvent
  ): Promise<WorkflowInstance> {
    // Get workflow instance
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Workflow instance not found: ${instanceId}`);
    }

    // Ensure workflow is paused
    if (instance.status !== 'paused') {
      throw new Error(
        `Cannot resume workflow that is not paused: ${instanceId}`
      );
    }

    // Update context with event data
    instance.context.data = {
      ...instance.context.data,
      ...event.data,
    };
    instance.context.lastUpdatedAt = new Date();

    // Update instance status
    instance.status = 'running';

    // Continue execution
    return this.executeStep(instance);
  }

  async getWorkflowInstance(
    instanceId: string
  ): Promise<WorkflowInstance | null> {
    return this.instances.get(instanceId) || null;
  }

  async listActiveWorkflows(): Promise<WorkflowSummary[]> {
    const activeInstances = Array.from(this.instances.values()).filter(
      instance => instance.status === 'running' || instance.status === 'paused'
    );

    return activeInstances.map(instance => ({
      id: instance.id,
      definition: instance.definition,
      currentStep: instance.context.currentStep,
      status: instance.status,
      startedAt: instance.context.startedAt,
      lastUpdatedAt: instance.context.lastUpdatedAt,
    }));
  }

  private async executeStep(
    instance: WorkflowInstance
  ): Promise<WorkflowInstance> {
    // Get workflow definition
    const definition = this.workflows.get(instance.definition);
    if (!definition) {
      throw new Error(`Workflow definition not found: ${instance.definition}`);
    }

    // Get current step
    const currentStepName = instance.context.currentStep;
    const currentStep = definition.steps.find(
      step => step.name === currentStepName
    );
    if (!currentStep) {
      throw new Error(`Step not found in workflow: ${currentStepName}`);
    }

    try {
      // Execute step handler
      const stepResult = await currentStep.handler(instance.context);

      // Store step result
      instance.context.results[currentStepName] = stepResult;

      // Find next step based on transitions
      const transition = definition.transitions.find(
        t =>
          t.from === currentStepName &&
          this.evaluateCondition(t.condition, stepResult)
      );

      if (transition) {
        // Update context for next step
        instance.context.currentStep = transition.to;
        instance.context.lastUpdatedAt = new Date();

        // Check if next step exists or if workflow is complete
        const nextStep = definition.steps.find(
          step => step.name === transition.to
        );
        if (nextStep) {
          // Continue to next step
          return this.executeStep(instance);
        } else {
          // Workflow completed
          instance.status = 'completed';
        }
      } else {
        // No transition found, pause workflow
        instance.status = 'paused';
      }

      return instance;
    } catch (error) {
      // Handle error
      instance.status = 'failed';
      instance.error = {
        step: currentStepName,
        message: (error as Error).message,
      };

      // Call error handler if defined
      if (definition.onError) {
        try {
          await definition.onError(
            error as Error,
            instance.context,
            currentStep
          );
        } catch (handlerError) {
          // Log error from error handler
          console.error('Error in workflow error handler:', handlerError);
        }
      }

      return instance;
    }
  }

  private evaluateCondition(
    condition: string | ((result: any) => boolean),
    result: any
  ): boolean {
    if (typeof condition === 'function') {
      return condition(result);
    }

    // Handle string conditions
    if (condition === 'always') {
      return true;
    }

    // Additional condition types could be added here

    return false;
  }
}
