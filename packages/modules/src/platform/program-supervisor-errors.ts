import type { InstallationId } from "../domain";

export type ModuleProgramSupervisorErrorCode =
  | "installation-not-found"
  | "stale-generation"
  | "version-not-found"
  | "already-active"
  | "startup-failed"
  | "cleanup-pending"
  | "teardown-failed"
  | "shutting-down";

export class ModuleProgramSupervisorError extends Error {
  readonly code: ModuleProgramSupervisorErrorCode;

  constructor(
    code: ModuleProgramSupervisorErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.name = "ModuleProgramSupervisorError";
  }
}

export function supervisorError(
  code: ModuleProgramSupervisorErrorCode,
  message: string,
  cause?: unknown
): ModuleProgramSupervisorError {
  return new ModuleProgramSupervisorError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

export function startupFailureMessage(
  installationId: InstallationId,
  error: unknown
): string {
  const messages: string[] = [];
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message && !messages.includes(current.message)) {
      messages.push(current.message);
    }
    current = current.cause;
  }
  const detail =
    messages.join(": ") ||
    (typeof error === "string" && error.length > 0 ? error : "unknown error");
  return `Could not start Installation ${installationId}: ${detail}`;
}
