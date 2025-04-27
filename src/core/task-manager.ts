import type { ServiceRegistry } from "./registry";

import {
  createSubtask,
  setSubtaskStatus,
  updateSubtask,
} from "../generators/generate-subtask";
import {
  createTask,
  setTaskStatus,
  updateTask,
} from "../generators/generate-task";
import {
  parseSubtaskContent,
  parseTaskContent,
} from "../generators/task-formatters";

// Task status enum
export enum TaskStatus {
  PENDING = "pending",
  IN_PROGRESS = "in-progress",
  REVIEW = "review",
  DONE = "done",
  DEFERRED = "deferred",
  CANCELLED = "cancelled",
}

// Task relationship enum
export enum TaskRelationship {
  DEPENDS_ON = "depends_on",
  RELATED_TO = "related_to",
  PARENT_OF = "parent_of",
  CHILD_OF = "child_of",
}

// Task model
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: "high" | "medium" | "low";
  details?: string;
  testStrategy?: string;
  dependencies: string[];
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  subtasks?: Subtask[];
}

// Subtask model
export interface Subtask {
  id: string;
  parentId: string;
  title: string;
  description: string;
  status: TaskStatus;
  details?: string;
  dependencies?: string[];
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

// Task input for creation
export interface TaskInput {
  title: string;
  description: string;
  status?: TaskStatus;
  priority?: "high" | "medium" | "low";
  details?: string;
  testStrategy?: string;
  dependencies?: string[];
}

// Subtask input for creation
export interface SubtaskInput {
  title: string;
  description: string;
  status?: TaskStatus;
  details?: string;
  dependencies?: string[];
}

// Task query options
export interface TaskQueryOptions {
  status?: TaskStatus | TaskStatus[];
  priority?: "high" | "medium" | "low";
  withSubtasks?: boolean;
  dependsOn?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// Task manager interface
export interface TaskManager {
  // Task Operations
  getTasks(options?: TaskQueryOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(task: TaskInput): Promise<Task>;
  updateTask(id: string, updates: Partial<TaskInput>): Promise<Task>;
  deleteTask(id: string): Promise<boolean>;

  // Subtask Operations
  getSubtasks(taskId: string): Promise<Subtask[]>;
  addSubtask(taskId: string, subtask: SubtaskInput): Promise<Subtask>;
  updateSubtask(
    taskId: string,
    subtaskId: string,
    updates: Partial<SubtaskInput>,
  ): Promise<Subtask>;
  setSubtaskStatus(
    taskId: string,
    subtaskId: string,
    status: TaskStatus,
  ): Promise<Subtask>;

  // Task Organization
  setTaskStatus(id: string, status: TaskStatus): Promise<Task>;
  linkTasks(
    sourceId: string,
    targetId: string,
    relationship: TaskRelationship,
  ): Promise<boolean>;
}

// Task manager implementation
export class TaskManagerImpl implements TaskManager {
  private serviceRegistry: ServiceRegistry;

  constructor(serviceRegistry: ServiceRegistry) {
    this.serviceRegistry = serviceRegistry;
  }

  async getTasks(options?: TaskQueryOptions): Promise<Task[]> {
    const adapter = this.serviceRegistry.getAdapter("default");

    // Construct path for tasks directory
    const path = "tasks";

    // List all task files
    const files = await adapter.list(path);

    // Read and parse each task file
    const tasks = await Promise.all(
      files
        .filter((file) => file.endsWith(".md"))
        .map(async (file) => {
          const result = await adapter.read(`${path}/${file}`);
          if (!result) return null;

          // Parse task content from markdown
          return parseTaskContent(result.content);
        }),
    );

    // Filter out nulls and apply query options
    const filteredTasks = tasks
      .filter((task): task is Task => task !== null)
      .filter((task) => this.matchesQueryOptions(task, options));

    // Load subtasks if requested
    if (options?.withSubtasks) {
      await Promise.all(
        filteredTasks.map(async (task) => {
          task.subtasks = await this.getSubtasks(task.id);
          return task;
        }),
      );
    }

    return filteredTasks;
  }

  private matchesQueryOptions(task: Task, options?: TaskQueryOptions): boolean {
    if (!options) return true;

    // Check status
    if (options.status) {
      if (Array.isArray(options.status)) {
        if (!options.status.includes(task.status)) return false;
      } else if (task.status !== options.status) {
        return false;
      }
    }

    // Check priority
    if (options.priority && task.priority !== options.priority) {
      return false;
    }

    // Check dependencies
    if (options.dependsOn && !task.dependencies.includes(options.dependsOn)) {
      return false;
    }

    // Check search term
    if (options.search) {
      const searchTerm = options.search.toLowerCase();
      const searchableText = `
        ${task.title.toLowerCase()}
        ${task.description.toLowerCase()}
        ${task.details?.toLowerCase() || ""}
        ${task.testStrategy?.toLowerCase() || ""}
      `;

      if (!searchableText.includes(searchTerm)) {
        return false;
      }
    }

    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const adapter = this.serviceRegistry.getAdapter("default");

    // Check if task exists
    if (!(await adapter.exists(`tasks/${id}.md`))) {
      return null;
    }

    // Read task file
    const result = await adapter.read(`tasks/${id}.md`);
    if (!result) return null;

    // Parse task content
    const task = parseTaskContent(result.content);
    if (!task) return null;

    // Load subtasks
    task.subtasks = await this.getSubtasks(id);

    return task;
  }

  async createTask(
    taskInput: TaskInput,
    options?: { model?: string },
  ): Promise<Task> {
    const adapter = this.serviceRegistry.getAdapter("default");
    const agent = this.serviceRegistry.getAgent("generator");
    const model = agent.languageModel(options?.model || "gpt-4o");
    // Generate task using the content generator
    const { task, content } = await createTask(
      model,
      taskInput,
      TaskStatus.PENDING,
    );

    // Create tasks directory if it doesn't exist
    if (!(await adapter.exists("tasks"))) {
      await adapter.createDirectory("tasks");
    }

    // Write task file
    await adapter.write(`tasks/${task.id}.md`, content, "text/markdown");

    return task;
  }

  async updateTask(
    id: string,
    updates: Partial<TaskInput>,
    options?: { model?: string },
  ): Promise<Task> {
    const adapter = this.serviceRegistry.getAdapter("default");
    const agent = this.serviceRegistry.getAgent("generator");
    const model = agent.languageModel(options?.model || "gpt-4o");

    // Get existing task
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // Update task using the content generator
    const { task: updatedTask, content } = await updateTask(
      model,
      task,
      updates,
    );

    // Write updated task file
    await adapter.write(`tasks/${id}.md`, content, "text/markdown");

    return updatedTask;
  }

  async deleteTask(id: string): Promise<boolean> {
    const adapter = this.serviceRegistry.getAdapter("default");

    // Check if task exists
    if (!(await adapter.exists(`tasks/${id}.md`))) {
      return false;
    }

    // Delete task file
    return adapter.delete(`tasks/${id}.md`);
  }

  async getSubtasks(taskId: string): Promise<Subtask[]> {
    const adapter = this.serviceRegistry.getAdapter("default");

    // Construct path for subtasks directory
    const path = `tasks/${taskId}/subtasks`;

    // Check if subtasks directory exists
    if (!(await adapter.exists(path))) {
      return [];
    }

    // List all subtask files
    const files = await adapter.list(path);

    // Read and parse each subtask file
    const subtasks = await Promise.all(
      files
        .filter((file) => file.endsWith(".md"))
        .map(async (file) => {
          const result = await adapter.read(`${path}/${file}`);
          if (!result) return null;

          // Parse subtask content
          return parseSubtaskContent(result.content, taskId);
        }),
    );

    // Filter out nulls
    return subtasks.filter((subtask): subtask is Subtask => subtask !== null);
  }

  async addSubtask(
    taskId: string,
    subtaskInput: SubtaskInput,
    options?: { model?: string },
  ): Promise<Subtask> {
    const adapter = this.serviceRegistry.getAdapter("default");
    const agent = this.serviceRegistry.getAgent("generator");
    const model = agent.languageModel(options?.model || "gpt-4o");
    // Get parent task
    const parentTask = await this.getTask(taskId);
    if (!parentTask) {
      throw new Error(`Parent task not found: ${taskId}`);
    }

    // Generate subtask using the content generator
    const { subtask, content } = await createSubtask(
      model,
      taskId,
      subtaskInput,
      TaskStatus.PENDING,
    );

    // Create subtasks directory if it doesn't exist
    const subtasksPath = `tasks/${taskId}/subtasks`;
    if (!(await adapter.exists(subtasksPath))) {
      await adapter.createDirectory(subtasksPath);
    }

    // Write subtask file
    await adapter.write(
      `${subtasksPath}/${subtask.id}.md`,
      content,
      "text/markdown",
    );

    return subtask;
  }

  async updateSubtask(
    taskId: string,
    subtaskId: string,
    updates: Partial<SubtaskInput>,
    options?: { model?: string },
  ): Promise<Subtask> {
    const adapter = this.serviceRegistry.getAdapter("default");
    const agent = this.serviceRegistry.getAgent("generator");
    const model = agent.languageModel(options?.model || "gpt-4o");

    // Get existing subtasks
    const subtasks = await this.getSubtasks(taskId);
    const subtask = subtasks.find((s) => s.id === subtaskId);

    if (!subtask) {
      throw new Error(`Subtask not found: ${subtaskId}`);
    }

    // Update subtask using the content generator
    const { subtask: updatedSubtask, content } = await updateSubtask(
      model,
      subtask,
      updates,
    );

    // Write updated subtask file
    const subtasksPath = `tasks/${taskId}/subtasks`;
    await adapter.write(
      `${subtasksPath}/${subtaskId}.md`,
      content,
      "text/markdown",
    );

    return updatedSubtask;
  }

  async setTaskStatus(
    id: string,
    status: TaskStatus,
    options?: { model?: string },
  ): Promise<Task> {
    const adapter = this.serviceRegistry.getAdapter("default");
    const agent = this.serviceRegistry.getAgent("generator");
    const model = agent.languageModel(options?.model || "gpt-4o");

    // Get existing task
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // Update task status using the content generator
    const { task: updatedTask, content } = await setTaskStatus(
      model,
      task,
      status,
    );

    // Write updated task file
    await adapter.write(`tasks/${id}.md`, content, "text/markdown");

    return updatedTask;
  }

  async setSubtaskStatus(
    taskId: string,
    subtaskId: string,
    status: TaskStatus,
    options?: { model?: string },
  ): Promise<Subtask> {
    const adapter = this.serviceRegistry.getAdapter("default");
    const agent = this.serviceRegistry.getAgent("generator");
    const model = agent.languageModel(options?.model || "gpt-4o");

    // Get existing subtasks
    const subtasks = await this.getSubtasks(taskId);
    const subtask = subtasks.find((s) => s.id === subtaskId);

    if (!subtask) {
      throw new Error(`Subtask not found: ${subtaskId}`);
    }

    // Update subtask status using the content generator
    const { subtask: updatedSubtask, content } = await setSubtaskStatus(
      model,
      subtask,
      status,
    );

    // Write updated subtask file
    const subtasksPath = `tasks/${taskId}/subtasks`;
    await adapter.write(
      `${subtasksPath}/${subtaskId}.md`,
      content,
      "text/markdown",
    );

    return updatedSubtask;
  }

  async linkTasks(
    sourceId: string,
    targetId: string,
    relationship: TaskRelationship,
    options?: { model?: string },
  ): Promise<boolean> {
    // Get source and target tasks
    const sourceTask = await this.getTask(sourceId);
    const targetTask = await this.getTask(targetId);

    if (!sourceTask || !targetTask) {
      throw new Error("Source or target task not found");
    }

    const adapter = this.serviceRegistry.getAdapter("default");
    const agent = this.serviceRegistry.getAgent("generator");
    const model = agent.languageModel(options?.model || "gpt-4o");

    switch (relationship) {
      case TaskRelationship.DEPENDS_ON:
        // Add target task ID to source task dependencies
        if (!sourceTask.dependencies.includes(targetId)) {
          sourceTask.dependencies.push(targetId);

          // Update source task using the content generator
          const { content } = await updateTask(model, sourceTask, {
            dependencies: sourceTask.dependencies,
          });

          // Write updated task file
          await adapter.write(`tasks/${sourceId}.md`, content, "text/markdown");
        }
        break;

      case TaskRelationship.RELATED_TO:
        // This could involve adding metadata to both tasks
        // For simplicity, this is not fully implemented here
        break;

      default:
        throw new Error(`Relationship type not implemented: ${relationship}`);
    }

    return true;
  }
}
