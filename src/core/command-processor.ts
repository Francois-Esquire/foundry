import type { ServiceRegistry } from './registry';

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
    args: Record<string, any>
  ): Promise<CommandResult> {
    const startTime = Date.now();

    try {
      // Check if command exists
      if (!this.hasCommand(command)) {
        return {
          success: false,
          error: {
            code: 'COMMAND_NOT_FOUND',
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
            code: 'INVALID_ARGUMENTS',
            message: 'Invalid command arguments',
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
          code: 'EXECUTION_ERROR',
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
    args: Record<string, any>
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
}
