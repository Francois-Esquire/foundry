import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFileRecorded } from "@foundry/lib/node/spawn-record";
import { z } from "zod";
import type { CliHarness, GuestAuth } from "~/lib/managers/cli-harnesses";

const execute = execFileRecorded;
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

export async function codexSubscriptionTokens(
  env?: Readonly<Record<string, string>>
): Promise<{ accessToken: string; chatgptAccountId: string }> {
  const dir = env?.CODEX_HOME ?? join(env?.HOME ?? homedir(), ".codex");
  let login: ReturnType<typeof codexLogin.safeParse> | undefined;
  try {
    const raw = await readFile(join(dir, "auth.json"), "utf8");
    login = codexLogin.safeParse(JSON.parse(raw));
  } catch {
    login = undefined;
  }
  if (login?.success) {
    return {
      accessToken: login.data.tokens.access_token,
      chatgptAccountId: login.data.tokens.account_id,
    };
  }
  throw new Error(
    "Codex subscription login is unavailable. Sign in with Codex on the host before starting a sandbox session."
  );
}

export interface ClaudeLoginLocation {
  readonly account: string;
  readonly file: string;
  readonly service: string;
}

const KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;

export function claudeLoginLocation(
  env: Readonly<Record<string, string | undefined>> = {},
  host: { readonly home: string; readonly user: string } = {
    home: homedir(),
    user: userInfo().username,
  }
): ClaudeLoginLocation {
  for (const name of ["HOME", "CLAUDE_CONFIG_DIR"] as const) {
    const value = env[name];
    if (value !== undefined && !isAbsolute(value)) {
      throw unlocatable(name);
    }
  }
  const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureDir && !isAbsolute(secureDir)) {
    throw unlocatable("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  }
  const home = env.HOME ?? host.home;
  const config = (env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")).normalize(
    "NFC"
  );
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  let hashed: string | undefined;
  if (secure === undefined) {
    hashed = env.CLAUDE_CONFIG_DIR ? config : undefined;
  } else {
    hashed = secure ? secure.normalize("NFC") : undefined;
  }
  const suffix = hashed
    ? `-${createHash("sha256").update(hashed).digest("hex").slice(0, 8)}`
    : "";
  const storage =
    secure === undefined
      ? config
      : (secure || join(home, ".claude")).normalize("NFC");
  const user = env.USER ?? host.user;
  return {
    account: KEYCHAIN_ACCOUNT.test(user) ? user : "claude-code-user",
    file: join(storage, ".credentials.json"),
    service: `Claude Code-credentials${suffix}`,
  };
}

function unlocatable(name: string): Error {
  return new Error(
    `This provider's Claude Code login cannot be located: its ${name} is empty or not an absolute path. Make it absolute, or supply CLAUDE_CODE_OAUTH_TOKEN from claude setup-token.`
  );
}

export async function claudeSubscriptionToken(
  options: {
    env?: Readonly<Record<string, string>>;
    platform?: string;
    readKeychain?: (location: ClaudeLoginLocation) => Promise<string>;
    readCredentials?: (path: string) => Promise<string>;
    oauthToken?: string;
  } = {}
): Promise<string> {
  const explicit = options.oauthToken;
  if (explicit) {
    return explicit;
  }
  const location = claudeLoginLocation(options.env);
  const sources: (() => Promise<string>)[] = [];
  if ((options.platform ?? process.platform) === "darwin") {
    const readKeychain =
      options.readKeychain ??
      (async ({ account, service }: ClaudeLoginLocation) =>
        (
          await execute(
            "/usr/bin/security",
            ["find-generic-password", "-a", account, "-w", "-s", service],
            options.env ? { env: { ...options.env } } : {}
          )
        ).stdout);
    sources.push(() => readKeychain(location));
  }
  const readCredentials =
    options.readCredentials ?? ((path: string) => readFile(path, "utf8"));
  sources.push(() => readCredentials(location.file));
  for (const read of sources) {
    let login: ReturnType<typeof claudeLogin.safeParse>;
    try {
      login = claudeLogin.safeParse(JSON.parse(await read()));
    } catch {
      continue;
    }
    if (
      login.success &&
      login.data.claudeAiOauth.expiresAt > Date.now() + 60_000
    ) {
      return login.data.claudeAiOauth.accessToken;
    }
  }
  throw new Error(
    "Claude Code subscription login is unavailable or expired. Sign in with Claude Code on the host, or supply CLAUDE_CODE_OAUTH_TOKEN from claude setup-token."
  );
}

type SubscriptionLogins = {
  readonly [H in CliHarness]: (
    oauthToken?: string,
    modelId?: string,
    env?: Readonly<Record<string, string>>,
    bin?: string
  ) => Promise<GuestAuth<H>>;
};

const SUBSCRIPTIONS: SubscriptionLogins = {
  "claude-code": async (oauthToken, _modelId, env) => ({
    kind: "oauth",
    token: await claudeSubscriptionToken({
      ...(env ? { env } : {}),
      ...((oauthToken ?? env?.CLAUDE_CODE_OAUTH_TOKEN)
        ? { oauthToken: oauthToken ?? env?.CLAUDE_CODE_OAUTH_TOKEN }
        : {}),
    }),
  }),
  codex: async (_oauthToken, _modelId, env) => ({
    kind: "chatgpt",
    tokens: await codexSubscriptionTokens(env),
  }),
  pi: async (_oauthToken, modelId, env, bin) => ({
    apiKey: await piCredential(modelId, (model) =>
      execute(bin ?? "pi", ["auth", "print-api-key", "--model", model], {
        ...(env ? { env } : {}),
        maxBuffer: 64 * 1024,
        timeout: 30_000,
      }).then(({ stdout }) => stdout)
    ),
    kind: "apiKey",
  }),
};

export async function piCredential(
  modelId = "anthropic/claude-sonnet-4-5",
  readKey: (model: string) => Promise<string> = async (model) =>
    (
      await execute("pi", ["auth", "print-api-key", "--model", model], {
        maxBuffer: 64 * 1024,
        timeout: 30_000,
      })
    ).stdout
): Promise<string> {
  let key: string;
  try {
    key = (await readKey(modelId)).trim();
  } catch {
    key = "";
  }
  if (key) {
    return key;
  }
  throw new Error(
    "Pi login is unavailable. Sign in with Pi on the host or supply a per-session API key."
  );
}

export async function guestAuth<H extends CliHarness>(
  harness: H,
  options: {
    readonly apiKey?: string;
    readonly bin?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly oauthToken?: string;
    readonly modelId?: string;
  },
  logins: SubscriptionLogins = SUBSCRIPTIONS
): Promise<GuestAuth<H>> {
  const auth: GuestAuth<H> = options.apiKey
    ? { apiKey: options.apiKey, kind: "apiKey" }
    : await logins[harness](
        options.oauthToken,
        options.modelId,
        options.env,
        options.bin
      );
  if (isBlank(auth)) {
    throw new Error(`${harness} requires explicit per-session authentication.`);
  }
  return auth;
}

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
