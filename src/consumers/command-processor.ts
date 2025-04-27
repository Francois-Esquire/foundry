import type { ServiceRegistry } from "../core/registry";

// Result of command validation
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

// Result of command execution
export interface CommandResult {
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata: {
    executionTime: number;
    resourceUsage?: ResourceUsage;
  };
}

// Resource usage info
export interface ResourceUsage {
  memoryUsage?: number;
  tokenUsage?: number;
  computeTime?: number;
}

// Command handler function type
export type CommandHandler = (args: Record<string, any>) => Promise<any>;

// Command processor interface
export interface CommandProcessor {
  // Command Handling
  execute(command: string, args: Record<string, any>): Promise<CommandResult>;

  // Command Registration
  registerCommand(name: string, handler: CommandHandler): void;
  hasCommand(name: string): boolean;

  // Command Validation
  validateCommand(command: string, args: Record<string, any>): ValidationResult;
}

// Command processor implementation
export class CommandProcessorImpl implements CommandProcessor {
  private commands: Map<string, CommandHandler> = new Map();
  private serviceRegistry: ServiceRegistry;

  constructor(serviceRegistry: ServiceRegistry) {
    this.serviceRegistry = serviceRegistry;
  }

  async execute(
    command: string,
    args: Record<string, any>,
  ): Promise<CommandResult> {
    const startTime = Date.now();

    try {
      // Check if command exists
      if (!this.hasCommand(command)) {
        return {
          success: false,
          error: {
            code: "COMMAND_NOT_FOUND",
            message: `Command not found: ${command}`,
          },
          metadata: {
            executionTime: Date.now() - startTime,
          },
        };
      }

      // Validate command arguments
      const validationResult = this.validateCommand(command, args);
      if (!validationResult.valid) {
        return {
          success: false,
          error: {
            code: "INVALID_ARGUMENTS",
            message: "Invalid command arguments",
            details: validationResult.errors,
          },
          metadata: {
            executionTime: Date.now() - startTime,
          },
        };
      }

      // Execute the command handler
      const handler = this.commands.get(command)!;
      const result = await handler(args);

      return {
        success: true,
        data: result,
        metadata: {
          executionTime: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "EXECUTION_ERROR",
          message: (error as Error).message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
        },
      };
    }
  }

  registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  hasCommand(name: string): boolean {
    return this.commands.has(name);
  }

  validateCommand(
    command: string,
    args: Record<string, any>,
  ): ValidationResult {
    // Basic validation - command must exist
    if (!this.hasCommand(command)) {
      return {
        valid: false,
        errors: [`Command not found: ${command}`],
      };
    }

    // Additional validation could be implemented here
    // For example, checking required arguments for specific commands

    return { valid: true };
  }

  initialize() {
    // Register task management commands
    this.commandProcessor.registerCommand("tasks.list", async (args) => {
      return this.taskManager.getTasks(args);
    });

    this.commandProcessor.registerCommand("tasks.get", async (args) => {
      if (!args.id) throw new Error("Task ID is required");
      return this.taskManager.getTask(args.id);
    });

    this.commandProcessor.registerCommand("tasks.create", async (args) => {
      if (!args.title || !args.description)
        throw new Error("Title and description are required");
      const taskInput: TaskInput = {
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        details: args.details,
        testStrategy: args.testStrategy,
        dependencies: args.dependencies,
      };
      return this.taskManager.createTask(taskInput);
    });

    this.commandProcessor.registerCommand("tasks.update", async (args) => {
      if (!args.id) throw new Error("Task ID is required");
      return this.taskManager.updateTask(args.id, args.updates || {});
    });

    this.commandProcessor.registerCommand("tasks.delete", async (args) => {
      if (!args.id) throw new Error("Task ID is required");
      return this.taskManager.deleteTask(args.id);
    });

    this.commandProcessor.registerCommand("tasks.status", async (args) => {
      if (!args.id || !args.status)
        throw new Error("Task ID and status are required");
      return this.taskManager.setTaskStatus(args.id, args.status);
    });

    // Register document generation commands
    this.commandProcessor.registerCommand(
      "documents.generatePRD",
      async (args) => {
        if (!args.concept) throw new Error("Concept is required");
        return this.documentGenerator.generatePRD(args.concept, args.options);
      },
    );

    this.commandProcessor.registerCommand(
      "documents.generateUserJourney",
      async (args) => {
        if (!args.persona || !args.scenario)
          throw new Error("Persona and scenario are required");
        return this.documentGenerator.generateUserJourney(
          args.persona,
          args.scenario,
        );
      },
    );

    this.commandProcessor.registerCommand(
      "documents.generateTechSpec",
      async (args) => {
        if (!args.requirements) throw new Error("Requirements are required");
        return this.documentGenerator.generateTechnicalSpec(
          args.requirements,
          args.options,
        );
      },
    );

    this.commandProcessor.registerCommand("documents.get", async (args) => {
      if (!args.id) throw new Error("Document ID is required");
      return this.documentGenerator.getDocument(args.id);
    });

    this.commandProcessor.registerCommand("documents.list", async (args) => {
      if (!args.type) throw new Error("Document type is required");
      return this.documentGenerator.listDocuments(args.type);
    });
  }
}
