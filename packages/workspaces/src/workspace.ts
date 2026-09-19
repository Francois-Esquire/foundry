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
