import { v4 as uuidv4 } from 'uuid';
import type { Task, TaskInput, TaskStatus } from '../core/task-manager';
import { formatTaskContent } from './task-formatters';

/**
 * Creates a new task from task input
 *
 * @param taskInput Task input data
 * @param defaultStatus Default status to use if not provided
 * @returns The created task object and its markdown content
 */
export function createTask(
  taskInput: TaskInput,
  defaultStatus: TaskStatus
): { task: Task; content: string } {
  // Generate task ID
  const id = uuidv4();

  // Create task object
  const task: Task = {
    id,
    title: taskInput.title,
    description: taskInput.description,
    status: taskInput.status || defaultStatus,
    priority: taskInput.priority || 'medium',
    details: taskInput.details,
    testStrategy: taskInput.testStrategy,
    dependencies: taskInput.dependencies || [],
    createdAt: new Date(),
    updatedAt: new Date(),
    subtasks: [],
  };

  // Convert task to markdown content
  const content = formatTaskContent(task);

  return { task, content };
}

/**
 * Updates an existing task
 *
 * @param task The existing task
 * @param updates Task update data
 * @returns The updated task object and its markdown content
 */
export function updateTask(
  task: Task,
  updates: Partial<TaskInput>
): { task: Task; content: string } {
  // Update task fields
  if (updates.title !== undefined) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.priority !== undefined) task.priority = updates.priority;
  if (updates.details !== undefined) task.details = updates.details;
  if (updates.testStrategy !== undefined)
    task.testStrategy = updates.testStrategy;
  if (updates.dependencies !== undefined)
    task.dependencies = updates.dependencies;

  // Update timestamp
  task.updatedAt = new Date();

  // Convert task to markdown content
  const content = formatTaskContent(task);

  return { task, content };
}

/**
 * Changes a task's status
 *
 * @param task The existing task
 * @param status New status to set
 * @returns The updated task object and its markdown content
 */
export function setTaskStatus(
  task: Task,
  status: TaskStatus
): { task: Task; content: string } {
  return updateTask(task, { status });
}
