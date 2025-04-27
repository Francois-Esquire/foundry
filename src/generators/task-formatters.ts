import type { Subtask, Task } from "../core/task-manager";

import { TaskStatus } from "../core/task-manager";

/**
 * Formats a task into markdown content with front matter
 */
export function formatTaskContent(task: Task): string {
  // Create front matter
  const frontMatter = [
    "---",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `priority: ${task.priority}`,
    `dependencies: [${task.dependencies.join(", ")}]`,
    `createdAt: ${task.createdAt.toISOString()}`,
    `updatedAt: ${task.updatedAt.toISOString()}`,
    task.completedAt ? `completedAt: ${task.completedAt.toISOString()}` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  // Build markdown content
  let content = `${frontMatter}\n\n${task.description}\n`;

  // Add implementation details if available
  if (task.details) {
    content += `\n## Implementation Details\n\n${task.details}\n`;
  }

  // Add test strategy if available
  if (task.testStrategy) {
    content += `\n## Test Strategy\n\n${task.testStrategy}\n`;
  }

  return content;
}

/**
 * Formats a subtask into markdown content with front matter
 */
export function formatSubtaskContent(subtask: Subtask): string {
  // Create front matter
  const frontMatter = [
    "---",
    `id: ${subtask.id}`,
    `parentId: ${subtask.parentId}`,
    `title: ${subtask.title}`,
    `status: ${subtask.status}`,
    subtask.dependencies
      ? `dependencies: [${subtask.dependencies.join(", ")}]`
      : null,
    `createdAt: ${subtask.createdAt.toISOString()}`,
    `updatedAt: ${subtask.updatedAt.toISOString()}`,
    subtask.completedAt
      ? `completedAt: ${subtask.completedAt.toISOString()}`
      : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  // Build markdown content
  let content = `${frontMatter}\n\n${subtask.description}\n`;

  // Add details if available
  if (subtask.details) {
    content += `\n## Details\n\n${subtask.details}\n`;
  }

  return content;
}

/**
 * Parses a task from markdown content
 */
export function parseTaskContent(content: string): Task | null {
  try {
    // Basic parsing of markdown content with front matter
    const frontMatterMatch = content.match(
      /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
    );

    if (!frontMatterMatch || !frontMatterMatch[1] || !frontMatterMatch[2]) {
      console.error("Invalid task format: Missing front matter");
      return null;
    }

    const frontMatter = frontMatterMatch[1];
    const description = frontMatterMatch[2].trim();

    // Parse front matter fields
    const id = extractField(frontMatter, "id") ?? "";
    const title = extractField(frontMatter, "title") ?? "";
    const statusField = extractField(frontMatter, "status");
    const status = statusField
      ? (statusField as TaskStatus)
      : TaskStatus.PENDING;
    const priorityField = extractField(frontMatter, "priority");
    const priority = (priorityField as "high" | "medium" | "low") || "medium";
    const dependencies = extractArrayField(frontMatter, "dependencies");

    const createdAtField = extractField(frontMatter, "createdAt");
    const createdAt = new Date(createdAtField ?? Date.now());

    const updatedAtField = extractField(frontMatter, "updatedAt");
    const updatedAt = new Date(updatedAtField ?? Date.now());

    const completedAtField = extractField(frontMatter, "completedAt");
    const completedAt = completedAtField
      ? new Date(completedAtField)
      : undefined;

    // Split description into parts
    const sections = description.split(/^## /m);
    if (!sections || sections.length === 0) {
      console.error("Invalid task format: Missing description");
      return null;
    }

    // Extract details and test strategy from sections
    let details = "";
    let testStrategy = "";

    if (sections && sections.length > 0) {
      for (const section of sections) {
        if (section && section.startsWith("Implementation Details")) {
          details = section.replace("Implementation Details\n", "").trim();
        } else if (section && section.startsWith("Test Strategy")) {
          testStrategy = section.replace("Test Strategy\n", "").trim();
        }
      }
    }

    return {
      id,
      title,
      description: sections[0]?.trim() ?? "", // First section is the description
      status,
      priority,
      details: details || undefined,
      testStrategy: testStrategy || undefined,
      dependencies,
      createdAt,
      updatedAt,
      completedAt,
    };
  } catch (error) {
    console.error("Error parsing task content:", error);
    return null;
  }
}

/**
 * Parses a subtask from markdown content
 */
export function parseSubtaskContent(
  content: string,
  parentId: string,
): Subtask | null {
  try {
    // Similar parsing logic to tasks, but simpler
    const frontMatterMatch = content.match(
      /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
    );

    if (!frontMatterMatch || !frontMatterMatch[1] || !frontMatterMatch[2]) {
      console.error("Invalid subtask format: Missing front matter");
      return null;
    }

    const frontMatter = frontMatterMatch[1];
    const description = frontMatterMatch[2].trim();

    // Parse front matter fields
    const id = extractField(frontMatter, "id") ?? "";
    const title = extractField(frontMatter, "title") ?? "";
    const statusField = extractField(frontMatter, "status");
    const status = statusField
      ? (statusField as TaskStatus)
      : TaskStatus.PENDING;
    const dependencies = extractArrayField(frontMatter, "dependencies");

    const createdAtField = extractField(frontMatter, "createdAt");
    const createdAt = new Date(createdAtField ?? Date.now());

    const updatedAtField = extractField(frontMatter, "updatedAt");
    const updatedAt = new Date(updatedAtField ?? Date.now());

    const completedAtField = extractField(frontMatter, "completedAt");
    const completedAt = completedAtField
      ? new Date(completedAtField)
      : undefined;

    // Extract details from the description
    const details = description.startsWith("## Details")
      ? description.replace("## Details\n", "").trim()
      : undefined;

    return {
      id,
      parentId,
      title,
      description,
      status,
      details,
      dependencies,
      createdAt,
      updatedAt,
      completedAt,
    };
  } catch (error) {
    console.error("Error parsing subtask content:", error);
    return null;
  }
}

/**
 * Extracts a field from front matter
 */
export function extractField(
  frontMatter: string,
  fieldName: string,
): string | null {
  const match = frontMatter.match(new RegExp(`${fieldName}:\\s*(.+)\\s*`));
  return match && match[1] ? match[1].trim() : null;
}

/**
 * Extracts an array field from front matter
 */
export function extractArrayField(
  frontMatter: string,
  fieldName: string,
): string[] {
  const match = frontMatter.match(
    new RegExp(`${fieldName}:\\s*\\[(.*)\\]\\s*`),
  );
  if (!match || !match[1]) return [];

  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
