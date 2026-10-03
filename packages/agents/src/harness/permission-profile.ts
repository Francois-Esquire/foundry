import type {
  HarnessPermissionProfile,
  HarnessPermissionRequest,
} from "./turn-driver";

const SHELL_CONTROL = /[;&|<>`\r\n$\\]/u;
const WILDCARD = /\*+/gu;

function commandInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("command" in input)) {
    return undefined;
  }
  return typeof input.command === "string" ? input.command : undefined;
}

function matchesRule(
  rule: string,
  request: HarnessPermissionRequest,
  allow: boolean
): boolean {
  const opening = rule.indexOf("(");
  const name = opening < 0 ? rule : rule.slice(0, opening);
  if (name.toLowerCase() !== request.toolName.toLowerCase()) {
    return false;
  }
  if (opening < 0) {
    return true;
  }
  if (!rule.endsWith(")")) {
    throw new Error(`Invalid harness permission rule: ${rule}`);
  }
  const command = commandInput(request.input);
  if (command === undefined) {
    return false;
  }
  // An allow never authorizes a second shell statement, substitution, or redirect.
  if (SHELL_CONTROL.test(command)) {
    return !allow;
  }
  const pattern = rule.slice(opening + 1, -1);
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (pattern.endsWith("*")) {
    const prefix = pattern.replace(WILDCARD, "").trimEnd();
    if (pattern.slice(0, -1).includes("*")) {
      throw new Error(
        "Harness command rules support only a trailing wildcard."
      );
    }
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === pattern;
}

export function harnessProfileDecision(
  profile: HarnessPermissionProfile,
  request: HarnessPermissionRequest
): "allow" | "deny" | "unresolved" {
  if (
    profile.disallowedTools.some((rule) => matchesRule(rule, request, false))
  ) {
    return "deny";
  }
  return profile.allowedTools.some((rule) => matchesRule(rule, request, true))
    ? "allow"
    : "unresolved";
}
