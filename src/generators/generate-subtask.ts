import { v4 as uuidv4 } from 'uuid';
import type { Subtask, SubtaskInput, TaskStatus } from '../core/task-manager';
import { formatSubtaskContent } from './task-formatters';
import type { LanguageModel } from 'ai';
import { generateText } from 'ai';

/**
 * Creates a new subtask
 *
 * @param taskId Parent task ID
 * @param subtaskInput Subtask input data
 * @param defaultStatus Default status to use if not provided
 * @returns The created subtask object and its markdown content
 */
export async function createSubtask(
  agent: LanguageModel,
  taskId: string,
  subtaskInput: SubtaskInput,
  defaultStatus: TaskStatus
): Promise<{ subtask: Subtask; content: string }> {
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
  const content = await generateText({
    model: agent,
    prompt: formatSubtaskContent(subtask),
  });

  return { subtask, content: content.text };
}

/**
 * Updates an existing subtask
 *
 * @param subtask The existing subtask
 * @param updates Subtask update data
 * @returns The updated subtask object and its markdown content
 */
export async function updateSubtask(
  agent: LanguageModel,
  subtask: Subtask,
  updates: Partial<SubtaskInput>
): Promise<{ subtask: Subtask; content: string }> {
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
  const content = await generateText({
    model: agent,
    prompt: formatSubtaskContent(subtask),
  });

  return { subtask, content: content.text };
}

/**
 * Changes a subtask's status
 *
 * @param subtask The existing subtask
 * @param status New status to set
 * @returns The updated subtask object and its markdown content
 */
export async function setSubtaskStatus(
  agent: LanguageModel,
  subtask: Subtask,
  status: TaskStatus
): Promise<{ subtask: Subtask; content: string }> {
  // Update subtask status
  subtask.status = status;
  subtask.updatedAt = new Date();

  // Convert subtask to markdown content
  const content = await generateText({
    model: agent,
    prompt: formatSubtaskContent(subtask),
  });

  return { subtask, content: content.text };
}
