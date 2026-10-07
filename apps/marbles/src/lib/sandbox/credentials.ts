import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { CliHarness, GuestAuth } from "~/lib/cli-harnesses";

const execute = promisify(execFile);
const claudeLogin = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number(),
  }),
});

const codexLogin = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

/** The app-server receives external auth tokens; the host retains refresh ownership. */
export async function codexSubscriptionTokens(
  home = homedir()
): Promise<{ accessToken: string; chatgptAccountId: string }> {
  try {
    const raw = await readFile(join(home, ".codex", "auth.json"), "utf8");
    const result = codexLogin.safeParse(JSON.parse(raw));
    if (result.success) {
      return {
        accessToken: result.data.tokens.access_token,
        chatgptAccountId: result.data.tokens.account_id,
      };
    }
  } catch {
    // Return a stable remedy without native errors that may contain credentials.
  }
  throw new Error(
    "Codex subscription login is unavailable. Sign in with Codex on the host before starting a sandbox session."
  );
}

/** Host-owned subscription login. Refresh credentials never enter the guest. */
export async function claudeSubscriptionToken(
  options: {
    home?: string;
    platform?: string;
    readKeychain?: () => Promise<string>;
    readCredentials?: () => Promise<string>;
    oauthToken?: string;
  } = {}
): Promise<string> {
  const explicit = options.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (explicit) {
    return explicit;
  }
  const home = options.home ?? homedir();
  const sources: (() => Promise<string>)[] = [];
  if ((options.platform ?? process.platform) === "darwin") {
    sources.push(
      options.readKeychain ??
        (async () =>
          (
            await execute("security", [
              "find-generic-password",
              "-s",
              "Claude Code-credentials",
              "-w",
            ])
          ).stdout)
    );
  }
  sources.push(
    options.readCredentials ??
      (() => readFile(join(home, ".claude", ".credentials.json"), "utf8"))
  );
  for (const read of sources) {
    try {
      const result = claudeLogin.safeParse(JSON.parse(await read()));
      if (
        result.success &&
        result.data.claudeAiOauth.expiresAt > Date.now() + 60_000
      ) {
        return result.data.claudeAiOauth.accessToken;
      }
    } catch {
      // A locked keychain or absent credential file is not a usable login.
    }
  }
  throw new Error(
    "Claude Code subscription login is unavailable or expired. Sign in with Claude Code on the host, or supply CLAUDE_CODE_OAUTH_TOKEN from claude setup-token."
  );
}

/** A host login for each CLI harness, used when the session brings no API key. */
type SubscriptionLogins = {
  readonly [H in CliHarness]: (oauthToken?: string) => Promise<GuestAuth<H>>;
};

const SUBSCRIPTIONS: SubscriptionLogins = {
  "claude-code": async (oauthToken) => ({
    kind: "oauth",
    token: await claudeSubscriptionToken({ oauthToken }),
  }),
  codex: async () => ({
    kind: "chatgpt",
    tokens: await codexSubscriptionTokens(),
  }),
};

/**
 * A guest session's credentials, decided once: the session's API key, else
 * the host's subscription login for that harness (`logins`, replaceable for
 * tests). A blank credential is
 * refused rather than sent to the guest.
 */
export async function guestAuth<H extends CliHarness>(
  harness: H,
  options: { readonly apiKey?: string; readonly oauthToken?: string },
  logins: SubscriptionLogins = SUBSCRIPTIONS
): Promise<GuestAuth<H>> {
  const auth: GuestAuth<H> = options.apiKey
    ? { apiKey: options.apiKey, kind: "apiKey" }
    : await logins[harness](options.oauthToken);
  if (isBlank(auth)) {
    throw new Error(`${harness} requires explicit per-session authentication.`);
  }
  return auth;
}

/** A key or token of only whitespace; Codex's login file is validated when read. */
function isBlank(auth: GuestAuth): boolean {
  switch (auth.kind) {
    case "apiKey":
      return !auth.apiKey.trim();
    case "oauth":
      return !auth.token.trim();
    default:
      return false;
  }
}
