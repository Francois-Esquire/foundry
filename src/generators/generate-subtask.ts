import { v4 as uuidv4 } from 'uuid';
import type { Subtask, SubtaskInput, TaskStatus } from '../core/task-manager';
import { formatSubtaskContent } from './task-formatters';

/**
 * Creates a new subtask
 *
 * @param taskId Parent task ID
 * @param subtaskInput Subtask input data
 * @param defaultStatus Default status to use if not provided
 * @returns The created subtask object and its markdown content
 */
export function createSubtask(
  taskId: string,
  subtaskInput: SubtaskInput,
  defaultStatus: TaskStatus
): { subtask: Subtask; content: string } {
  // Generate subtask ID
  const subtaskId = uuidv4();

  // Create subtask object
  const subtask: Subtask = {
    id: subtaskId,
    parentId: taskId,
    title: subtaskInput.title,
    description: subtaskInput.description,
    status: subtaskInput.status || defaultStatus,
    details: subtaskInput.details,
    dependencies: subtaskInput.dependencies,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Convert subtask to markdown content
  const content = formatSubtaskContent(subtask);

  return { subtask, content };
}

/**
 * Updates an existing subtask
 *
 * @param subtask The existing subtask
 * @param updates Subtask update data
 * @returns The updated subtask object and its markdown content
 */
export function updateSubtask(
  subtask: Subtask,
  updates: Partial<SubtaskInput>
): { subtask: Subtask; content: string } {
  // Update subtask fields
  if (updates.title !== undefined) subtask.title = updates.title;
  if (updates.description !== undefined)
    subtask.description = updates.description;
  if (updates.status !== undefined) subtask.status = updates.status;
  if (updates.details !== undefined) subtask.details = updates.details;
  if (updates.dependencies !== undefined)
    subtask.dependencies = updates.dependencies;

  // Update timestamp
  subtask.updatedAt = new Date();

  // Convert subtask to markdown content
  const content = formatSubtaskContent(subtask);

  return { subtask, content };
}

/**
 * Changes a subtask's status
 *
 * @param subtask The existing subtask
 * @param status New status to set
 * @returns The updated subtask object and its markdown content
 */
export function setSubtaskStatus(
  subtask: Subtask,
  status: TaskStatus
): { subtask: Subtask; content: string } {
  return updateSubtask(subtask, { status });
}
