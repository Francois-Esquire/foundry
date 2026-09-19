import type { WorkspaceSourceIssue } from "./types";

/** The errno alone, never the message, which carries the absolute path. */
export function errorCode(error: unknown): string {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
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

/** The source could not be observed completely, so no catalog was mutated. */
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

/**
 * A refused read is `unreadable`; anything else that broke mid-walk is a scan
 * failure. The errno is the only part of a Node error safe to consult — its
 * message embeds the absolute path.
 */
export function sourceIssueFor(cause: unknown): WorkspaceSourceIssue {
  const code: unknown = (cause as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM" ? "unreadable" : "scan-failed";
}

export class WorkspacePersistenceError extends WorkspaceSystemError {}

export class WorkspaceSourceUnsupportedError extends WorkspaceSystemError {
  constructor(source: string) {
    super(`No registered Workspace layer claims the source "${source}"`);
  }
}
