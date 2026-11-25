import type { Capability, ToolSource } from "./capability";

export interface HarnessPermissionProfile {
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  maxSteps: number;
  mode: "scheduled" | "attended";
  unresolved: "ask" | "deny";
}

export function validateHarnessProfile(
  profile: Pick<HarnessPermissionProfile, "maxSteps">
): void {
  if (!Number.isSafeInteger(profile.maxSteps) || profile.maxSteps < 1) {
    throw new Error("Harness maxSteps must be a positive safe integer.");
  }
}

export interface HarnessPermissionRequest {
  activityId?: string;
  capability?: Capability;
  input: unknown;
  sessionId: string;
  signal: AbortSignal;
  source?: ToolSource;
  suggestions?: unknown;
  title?: string;
  toolCallId: string;
  toolName: string;
}

export type HarnessPermissionResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

export type HarnessPermissionCallback = (
  request: HarnessPermissionRequest
) => Promise<HarnessPermissionResult>;
