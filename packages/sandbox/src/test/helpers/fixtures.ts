import type { SandboxCommand } from "../../types";

export const SANDBOX_ARGV_FIXTURE: SandboxCommand = Object.freeze([
  "printf",
  "%s",
  "argv value",
]);
export const SANDBOX_SHELL_FIXTURE: SandboxCommand =
  "printf '%s' 'shell value'";
