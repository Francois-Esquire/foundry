export const SESSION_ROLES = [
  "user",
  "assistant",
  "system",
  "tool",
  "summary",
] as const;

export const MESSAGE_STATUSES = ["streaming", "complete", "error"] as const;

export const SESSION_STATUSES = ["active", "archived", "error"] as const;
