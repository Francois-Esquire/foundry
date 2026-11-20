import type { WorkspaceSourceIssue } from "./types";

export function errorCode(error: unknown): string {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    return code;
  }
  return error instanceof Error ? error.name : "unknown";
}

export class WorkspaceSystemError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidWorkspaceInputError extends WorkspaceSystemError {}

export class WorkspaceNotFoundError extends WorkspaceSystemError {
  constructor(workspaceId: string) {
    super(`Workspace not found: ${workspaceId}`);
  }
}

export class WorkspaceFileNotFoundError extends WorkspaceSystemError {
  constructor(workspaceId: string, fileId: string) {
    super(`File ${fileId} does not belong to Workspace ${workspaceId}`);
  }
}

export class WorkspaceSourceUnavailableError extends WorkspaceSystemError {
  readonly issue: WorkspaceSourceIssue;

  constructor(
    message: string,
    options?: { cause?: unknown; issue?: WorkspaceSourceIssue }
  ) {
    super(message, options);
    this.issue = options?.issue ?? "scan-failed";
  }
}

export function sourceIssueFor(cause: unknown): WorkspaceSourceIssue {
  const code = errorCode(cause);
  return code === "EACCES" || code === "EPERM" ? "unreadable" : "scan-failed";
}

export function rootIssueFor(cause: unknown): WorkspaceSourceIssue {
  const code = errorCode(cause);
  return code === "ENOENT" || code === "ENOTDIR"
    ? "unavailable"
    : sourceIssueFor(cause);
}

export class WorkspacePersistenceError extends WorkspaceSystemError {}

export class WorkspaceSourceUnsupportedError extends WorkspaceSystemError {
  constructor(source: string) {
    super(`No registered Workspace layer claims the source "${source}"`);
  }
}
