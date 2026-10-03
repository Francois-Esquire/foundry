import type { HarnessPermissionProfile } from "@foundry/agents/harness";
import type { AppServerConnection } from "./app-server";
import type { CodexDriverOptions } from "./codex";
export async function authenticate(
  connection: AppServerConnection,
  options: CodexDriverOptions
): Promise<void> {
  if (options.chatgptAuthTokens) {
    await connection.request("account/login/start", {
      type: "chatgptAuthTokens",
      ...options.chatgptAuthTokens,
    });
    return;
  }
  const apiKey = options.apiKey ?? options.env?.OPENAI_API_KEY;
  if (apiKey) {
    await connection.request("account/login/start", { apiKey, type: "apiKey" });
  }
}

export async function refreshSubscription(
  connection: AppServerConnection,
  params: Record<string, unknown>,
  id: string | number,
  options: CodexDriverOptions,
  signal: AbortSignal
): Promise<void> {
  if (!options.refreshChatgptAuthTokens) {
    connection.respondError(
      id,
      "Codex subscription access token expired. Refresh the host login and start a new turn."
    );
    return;
  }
  const tokens = await options.refreshChatgptAuthTokens({
    reason: String(params.reason ?? "expired"),
    ...(typeof params.previousAccountId === "string"
      ? { previousAccountId: params.previousAccountId }
      : {}),
    signal,
  });
  signal.throwIfAborted();
  connection.respond(id, tokens);
}

export function codexSandbox(
  profile: HarnessPermissionProfile,
  requested?: "read-only" | "workspace-write"
): "read-only" | "workspace-write" {
  const writeTools = ["Write", "Edit", "fileChange"];
  const unsupported = profile.disallowedTools.find(
    (tool) => !writeTools.includes(tool)
  );
  if (unsupported) {
    throw new Error(
      `Codex cannot enforce deny rule ${unsupported} through app-server. Remove this rule or use Claude Code; unsupported deny rules fail before launch.`
    );
  }
  if (
    requested === "read-only" ||
    profile.disallowedTools.some((tool) => writeTools.includes(tool))
  ) {
    return "read-only";
  }
  return profile.allowedTools.some((tool) => writeTools.includes(tool))
    ? "workspace-write"
    : "read-only";
}
