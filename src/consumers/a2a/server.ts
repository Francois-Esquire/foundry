// TODO: replace with mcp stateless server implementation
/**
 * @reference https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#without-session-management-stateless
 */

import { serve } from 'bun';

// Define the types since we don't have the actual A2A package yet
// These interfaces match what we saw in the documentation
interface TaskPart {
  text: string;
  type: string;
}

interface TaskMessage {
  role: string;
  parts: TaskPart[];
}

interface Task {
  id: string;
  message?: TaskMessage;
}

interface TaskContext {
  task: Task;
  isCancelled: () => boolean;
}

// Update the interface to make name/parts optional and state required
interface TaskYieldUpdate {
  state: string;
  message?: TaskMessage;
  name?: string;
  mimeType?: string;
  parts?: TaskPart[];
}

// A simplified implementation of A2A classes until we have the actual package
class InMemoryTaskStore {
  private tasks = new Map<string, Task>();

  async addTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) || null;
  }
}

class A2AServer {
  options: { port: number; taskStore: InMemoryTaskStore };
  private taskHandler: (
    context: TaskContext
  ) => AsyncGenerator<TaskYieldUpdate>;

  constructor(
    taskHandler: (context: TaskContext) => AsyncGenerator<TaskYieldUpdate>,
    options: { taskStore: InMemoryTaskStore; port?: number }
  ) {
    this.taskHandler = taskHandler;
    this.options = {
      port: options.port || 41241,
      taskStore: options.taskStore,
    };
  }

  start(): void {
    // This would be replaced with actual server implementation
    console.log(`Starting A2A server on port ${this.options.port}`);
    serve({
      port: this.options.port,
      async fetch(req) {
        // Simplified handling - would be replaced with actual JSON-RPC implementation
        if (req.method === 'POST') {
          try {
            const body = await req.json();
            // Handle JSON-RPC request here
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (error) {
            return new Response(JSON.stringify({ error: 'Invalid request' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        return new Response('A2A Server is running', { status: 200 });
      },
    });
  }
}

/**
 * Task handler for the A2A server that processes commands similar to CLI
 */
async function* foundryAgentLogic(
  context: TaskContext
): AsyncGenerator<TaskYieldUpdate> {
  console.log(`Handling task: ${context.task.id}`);

  // Initial status - we're working on it
  yield {
    state: 'working',
    message: {
      role: 'agent',
      parts: [{ text: 'Processing your command...', type: 'text' }],
    },
  };

  try {
    // Get the command from the message text
    const userMessage = context.task.message;
    if (!userMessage || !userMessage.parts || !userMessage.parts.length) {
      throw new Error('No message content provided');
    }

    const messagePart = userMessage.parts.find(
      (part: TaskPart) => part.type === 'text'
    );
    if (!messagePart || !messagePart.text) {
      throw new Error('Text message required');
    }

    const commandText = messagePart.text;
    console.log(`Processing command: ${commandText}`);

    // Parse the command to extract the main command and arguments
    const parts = commandText.trim().split(/\s+/);
    const mainCommand = parts[0];
    const subCommand = parts.length > 1 ? parts[1] || '' : '';
    const args = parts.slice(2);

    // Check for cancellation
    if (context.isCancelled()) {
      console.log('Task cancelled!');
      yield { state: 'canceled' };
      return;
    }

    // Progress update
    yield {
      state: 'working',
      message: {
        role: 'agent',
        parts: [
          { text: `Executing ${mainCommand} ${subCommand}...`, type: 'text' },
        ],
      },
    };

    // Simulate command execution based on the CLI commands
    let result: string;

    switch (mainCommand) {
      case 'start':
        result = await handleStartCommand(args);
        break;
      case 'configure':
        result = await handleConfigureCommand(args);
        break;
      case 'generate':
        result = await handleGenerateCommand(subCommand, args);
        break;
      case 'tasks':
        result = await handleTasksCommand(subCommand, args);
        break;
      case 'show': {
        const taskIdFromArgs =
          args.length > 0 && !args[0]?.startsWith('--') ? args[0] : '';
        const hasId = args.includes('--id');
        const idIndex = args.indexOf('--id');
        const taskIdFromOption =
          hasId && idIndex + 1 < args.length ? args[idIndex + 1] : '';
        const taskId = taskIdFromArgs || taskIdFromOption || '';

        result = `Showing task details for ID: ${taskId || 'not specified'}`;
        break;
      }
      case 'update': {
        const hasFrom = args.includes('--from');
        const fromIndex = args.indexOf('--from');
        const fromValue =
          hasFrom && fromIndex + 1 < args.length ? args[fromIndex + 1] : '';

        const hasPrompt = args.includes('--prompt');
        const promptIndex = args.indexOf('--prompt');
        const promptValue =
          hasPrompt && promptIndex + 1 < args.length
            ? args[promptIndex + 1]
            : '';

        const hasResearch = args.includes('--research');

        result = `Updating tasks${fromValue ? ` from ID: ${fromValue}` : ''}${
          promptValue ? `, with context: "${promptValue}"` : ''
        }${hasResearch ? ', using research-backed updates' : ''}`;
        break;
      }
      case 'update-task': {
        const hasId = args.includes('--id');
        const idIndex = args.indexOf('--id');
        const id = hasId && idIndex + 1 < args.length ? args[idIndex + 1] : '';

        const hasPrompt = args.includes('--prompt');
        const promptIndex = args.indexOf('--prompt');
        const promptValue =
          hasPrompt && promptIndex + 1 < args.length
            ? args[promptIndex + 1]
            : '';

        const hasResearch = args.includes('--research');

        result = `Updating task${id ? ` with ID: ${id}` : ''}${
          promptValue ? `, with context: "${promptValue}"` : ''
        }${hasResearch ? ', using research-backed updates' : ''}`;
        break;
      }
      case 'modify-task': {
        const taskId = args.length > 0 ? args[0] : '';
        const action = args.length > 1 ? args[1] : '';
        let subTaskId: string | undefined;

        if (action === 'add-subtask') {
          const titleIndex = args.indexOf('--title');
          const title =
            titleIndex !== -1 && titleIndex + 1 < args.length
              ? args[titleIndex + 1]
              : '';

          result = `Adding subtask to task ${taskId}${
            title ? ` with title: ${title}` : ''
          }`;
        } else if (action === 'remove-subtask') {
          subTaskId = args.length > 2 ? args[2] : '';
          result = `Removing subtask ${subTaskId || ''} from task ${taskId}`;
        } else {
          result = `Unknown modify-task action: ${action}`;
        }
        break;
      }
      default:
        result = `Unknown command: ${mainCommand}. Available commands: start, configure, generate, tasks, show, update, update-task, modify-task`;
    }

    // Yield the result as an artifact
    yield {
      state: 'working', // Add state property
      name: 'result.json',
      mimeType: 'application/json',
      parts: [
        {
          text: JSON.stringify(
            {
              command: `${mainCommand} ${subCommand}`.trim(),
              args,
              result,
            },
            null,
            2
          ),
          type: 'text',
        },
      ],
    };

    // Final status - we're done
    yield {
      state: 'completed',
      message: {
        role: 'agent',
        parts: [{ text: result, type: 'text' }],
      },
    };
  } catch (error) {
    console.error('Error processing command:', error);

    // Yield error status
    yield {
      state: 'error',
      message: {
        role: 'agent',
        parts: [
          {
            text: `Error processing command: ${
              error instanceof Error ? error.message : String(error)
            }`,
            type: 'text',
          },
        ],
      },
    };
  }
}

/**
 * Handle the "start" command
 */
async function handleStartCommand(args: string[]): Promise<string> {
  const hasPrompt = args.includes('--prompt');
  const promptIndex = args.indexOf('--prompt');
  const prompt =
    promptIndex !== -1 && promptIndex + 1 < args.length
      ? args[promptIndex + 1]
      : '';

  const hasResearch = args.includes('--research');
  const hasAuto = args.includes('--auto');

  let result = 'Starting Foundry';
  if (prompt) {
    result += ` with prompt: "${prompt}"`;
  }
  if (hasResearch) {
    result += ', research mode enabled';
  }
  if (hasAuto) {
    result += ', using auto mode';
  }

  // Here you would add the actual implementation
  return result;
}

/**
 * Handle the "configure" command
 */
async function handleConfigureCommand(args: string[]): Promise<string> {
  const hasModel = args.includes('--model');
  const modelIndex = args.indexOf('--model');
  const model =
    modelIndex !== -1 && modelIndex + 1 < args.length
      ? args[modelIndex + 1]
      : undefined;

  const hasRole = args.includes('--role');
  const roleIndex = args.indexOf('--role');
  const role =
    roleIndex !== -1 && roleIndex + 1 < args.length
      ? args[roleIndex + 1]
      : undefined;

  const hasTemperature = args.includes('--temperature');
  const temperatureIndex = args.indexOf('--temperature');
  const temperature =
    temperatureIndex !== -1 && temperatureIndex + 1 < args.length
      ? args[temperatureIndex + 1]
      : undefined;

  let result = 'Configuring Foundry';
  if (model) {
    result += ` with model: "${model}"`;
  }
  if (role) {
    result += `, role: "${role}"`;
  }
  if (temperature) {
    result += `, temperature: ${temperature}`;
  }

  // Here you would add the actual implementation
  return result;
}

/**
 * Handle the "generate" command
 */
async function handleGenerateCommand(
  subCommand: string,
  args: string[]
): Promise<string> {
  const hasPrompt = args.includes('--prompt');
  const promptIndex = args.indexOf('--prompt');
  const prompt =
    promptIndex !== -1 && promptIndex + 1 < args.length
      ? args[promptIndex + 1]
      : undefined;

  let result = '';

  switch (subCommand) {
    case 'user-journey':
      result = `Generating user journey${
        prompt ? ` with prompt: "${prompt}"` : ''
      }`;
      break;
    case 'brand-guide':
      result = `Generating brand guide${
        prompt ? ` with prompt: "${prompt}"` : ''
      }`;
      break;
    case 'style-guide':
      result = `Generating style guide${
        prompt ? ` with prompt: "${prompt}"` : ''
      }`;
      break;
    case 'prd':
      result = `Generating PRD${prompt ? ` with prompt: "${prompt}"` : ''}`;
      break;
    default:
      result = `Unknown generate subcommand: ${subCommand}. Available subcommands: user-journey, brand-guide, style-guide, prd`;
  }

  // Here you would add the actual implementation
  return result;
}

/**
 * Handle the "tasks" command with its various subcommands
 */
async function handleTasksCommand(
  subCommand: string,
  args: string[]
): Promise<string> {
  let result = '';

  switch (subCommand) {
    case 'parse-prd': {
      const prdFile =
        args.length > 0 && !args[0]?.startsWith('--') ? args[0] : '';
      const hasNumTasks = args.includes('--num-tasks');
      const numTasksIndex = args.indexOf('--num-tasks');
      const numTasks =
        numTasksIndex !== -1 && numTasksIndex + 1 < args.length
          ? args[numTasksIndex + 1]
          : '';

      result = `Parsing PRD${prdFile ? ` file: ${prdFile}` : ''}${
        numTasks ? `, limiting to ${numTasks} tasks` : ''
      }`;
      break;
    }

    case 'list': {
      const hasStatus = args.includes('--status');
      const statusIndex = args.indexOf('--status');
      const status =
        statusIndex !== -1 && statusIndex + 1 < args.length
          ? args[statusIndex + 1]
          : undefined;
      const hasWithSubtasks = args.includes('--with-subtasks');

      result = `Listing tasks${status ? ` with status: ${status}` : ''}${
        hasWithSubtasks ? ', including subtasks' : ''
      }`;
      break;
    }

    case 'next':
      result = 'Finding next task';
      break;

    case 'show': {
      const taskIdFromArgs =
        args.length > 0 && !args[0]?.startsWith('--') ? args[0] : '';
      const hasId = args.includes('--id');
      const idIndex = args.indexOf('--id');
      const taskIdFromOption =
        hasId && idIndex + 1 < args.length ? args[idIndex + 1] : '';
      const taskId = taskIdFromArgs || taskIdFromOption || '';

      result = `Showing task details for ID: ${taskId || 'not specified'}`;
      break;
    }

    case 'update': {
      const hasFrom = args.includes('--from');
      const fromIndex = args.indexOf('--from');
      const fromValue =
        hasFrom && fromIndex + 1 < args.length ? args[fromIndex + 1] : '';

      const hasPrompt = args.includes('--prompt');
      const promptIndex = args.indexOf('--prompt');
      const promptValue =
        hasPrompt && promptIndex + 1 < args.length ? args[promptIndex + 1] : '';

      const hasResearch = args.includes('--research');

      result = `Updating tasks${fromValue ? ` from ID: ${fromValue}` : ''}${
        promptValue ? `, with context: "${promptValue}"` : ''
      }${hasResearch ? ', using research-backed updates' : ''}`;
      break;
    }

    case 'update-task': {
      const hasId = args.includes('--id');
      const idIndex = args.indexOf('--id');
      const id = hasId && idIndex + 1 < args.length ? args[idIndex + 1] : '';

      const hasPrompt = args.includes('--prompt');
      const promptIndex = args.indexOf('--prompt');
      const promptValue =
        hasPrompt && promptIndex + 1 < args.length ? args[promptIndex + 1] : '';

      const hasResearch = args.includes('--research');

      result = `Updating task${id ? ` with ID: ${id}` : ''}${
        promptValue ? `, with context: "${promptValue}"` : ''
      }${hasResearch ? ', using research-backed updates' : ''}`;
      break;
    }

    case 'modify-task': {
      const taskId = args.length > 0 ? args[0] : '';
      const action = args.length > 1 ? args[1] : '';
      let subTaskId: string | undefined;

      if (action === 'add-subtask') {
        const titleIndex = args.indexOf('--title');
        const title =
          titleIndex !== -1 && titleIndex + 1 < args.length
            ? args[titleIndex + 1]
            : '';

        result = `Adding subtask to task ${taskId}${
          title ? ` with title: ${title}` : ''
        }`;
      } else if (action === 'remove-subtask') {
        subTaskId = args.length > 2 ? args[2] : '';
        result = `Removing subtask ${subTaskId || ''} from task ${taskId}`;
      } else {
        result = `Unknown modify-task action: ${action}`;
      }
      break;
    }

    // Add other task subcommands as needed (update-task, update-subtask, generate, set-status, etc.)

    default:
      result = `Executing tasks ${subCommand} command with args: ${args.join(
        ' '
      )}`;
  }

  // Here you would add the actual implementation
  return result;
}

// Create A2A server
const taskStore = new InMemoryTaskStore();
const server = new A2AServer(foundryAgentLogic, {
  taskStore,
  port: process.env.A2A_PORT ? parseInt(process.env.A2A_PORT, 10) : 41241,
});

// Export the server for use in other files
export default server;
