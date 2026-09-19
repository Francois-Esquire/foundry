import { z } from "zod";
import type { WorkspaceRegistration, WorkspaceSummary } from "./types";

export const workspaceIdSchema = z
  .string()
  .min(1, "WorkspaceId must not be empty")
  .brand("WorkspaceId");

export const workspaceEntryIdSchema = z
  .string()
  .min(1, "WorkspaceEntryId must not be empty")
  .brand("WorkspaceEntryId");

/**
 * The coarse whole-file categories. Deliberately not code symbols: a `FileKind`
 * classifies the file, a symbol is a future analysis-derived declaration.
 */
export const FILE_KINDS = [
  "code",
  "document",
  "image",
  "audio",
  "video",
  "data",
  "config",
  "skill",
  "agent",
  "other",
] as const;

export function workspaceSummary(
  workspace: WorkspaceRegistration,
  fileCount: number
): WorkspaceSummary {
  return {
    createdAt: workspace.createdAt,
    description: workspace.description,
    fileCount,
    id: workspace.id,
    lastReconciledAt: workspace.lastReconciledAt,
    name: workspace.name,
    sourceKind: workspace.source.kind,
    updatedAt: workspace.updatedAt,
  };
}
