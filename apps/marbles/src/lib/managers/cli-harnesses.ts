export const CLI_HARNESS_IDS = ["claude-code", "codex", "pi"] as const;
export type CliHarness = (typeof CLI_HARNESS_IDS)[number];

export type GuestArchitecture = "aarch64" | "x86_64";

const NPM_ARCHITECTURE: Record<GuestArchitecture, "arm64" | "x64"> = {
  aarch64: "arm64",
  x86_64: "x64",
};

export interface GuestFile {
  readonly executable: boolean;
  readonly member: string;
  readonly path: string;
}

export interface GuestArtifact {
  readonly archive?: { readonly sha256: string; readonly url: string };
  readonly executable: string;
  readonly files: readonly GuestFile[];
  readonly packageName: string;
  readonly version: string;
}

interface ApiKeyAuth {
  readonly apiKey: string;
  readonly kind: "apiKey";
}

interface ClaudeOauthAuth {
  readonly kind: "oauth";
  readonly token: string;
}

interface ChatgptAuth {
  readonly kind: "chatgpt";
  readonly tokens: {
    readonly accessToken: string;
    readonly chatgptAccountId: string;
  };
}

interface GuestAuthentication {
  readonly "claude-code": ApiKeyAuth | ClaudeOauthAuth;
  readonly codex: ApiKeyAuth | ChatgptAuth;
  readonly pi: ApiKeyAuth;
}

export type GuestAuth<H extends CliHarness = CliHarness> =
  GuestAuthentication[H];

export interface CliHarnessDescriptor<H extends CliHarness> {
  artifact(architecture: GuestArchitecture): GuestArtifact;
  env(state: string, auth: GuestAuth<H>): Readonly<Record<string, string>>;
  readonly executor: TurnExecutorRef & { readonly harness: H };
  readonly expectedVersion: string;
  readonly stateDir: string;
}

const CLAUDE_SDK_VERSION = "0.3.205";
const CLAUDE_CLI_VERSION = "2.1.205";
const CODEX_VERSION = "0.144.6";
const PI_VERSION = "1.3.0";
const PI_CHECKSUMS: Record<GuestArchitecture, string> = {
  aarch64: "7fd2ea14fca390ebf9f47438baaef07c4b3d13db7cc8e459831118391b7ea65b",
  x86_64: "24f5be328b66d4da36876296989501974f43ab8434fbb57c35c523a3ea505ded",
};

const CLAUDE_STATE_DIR = "claude";
const CODEX_STATE_DIR = "codex";

const CODEX_MEMBERS = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-resources/bwrap",
  "codex-resources/zsh/bin/zsh",
  "codex-path/rg",
  "codex-package.json",
];

export const CLI_HARNESSES: {
  readonly [H in CliHarness]: CliHarnessDescriptor<H>;
} = {
  "claude-code": {
    artifact: (architecture) => ({
      executable: "/opt/foundry/bin/claude",
      files: [
        {
          executable: true,
          member: "package/claude",
          path: "/opt/foundry/bin/claude",
        },
      ],
      packageName: `@anthropic-ai/claude-agent-sdk-linux-${NPM_ARCHITECTURE[architecture]}`,
      version: CLAUDE_SDK_VERSION,
    }),
    env: (state, auth) => ({
      CLAUDE_CONFIG_DIR: `${state}/${CLAUDE_STATE_DIR}`,
      ...(auth.kind === "oauth"
        ? { CLAUDE_CODE_OAUTH_TOKEN: auth.token }
        : { ANTHROPIC_API_KEY: auth.apiKey }),
    }),
    executor: {
      harness: "claude-code",
      model: "opus",
      provider: "claude-code",
    },
    expectedVersion: CLAUDE_CLI_VERSION,
    stateDir: CLAUDE_STATE_DIR,
  },
  codex: {
    artifact: (architecture) => ({
      executable: "/opt/foundry/bin/codex",
      files: CODEX_MEMBERS.map((member) => ({
        executable: member !== "codex-package.json",
        member: `package/vendor/${architecture}-unknown-linux-musl/${member}`,
        path: `/opt/foundry/${member}`,
      })),
      packageName: "@openai/codex",
      version: `${CODEX_VERSION}-linux-${NPM_ARCHITECTURE[architecture]}`,
    }),
    env: (state, auth) => ({
      CODEX_HOME: `${state}/${CODEX_STATE_DIR}`,
      ...(auth.kind === "apiKey" ? { OPENAI_API_KEY: auth.apiKey } : {}),
    }),
    executor: { harness: "codex", model: "gpt-5.5", provider: "codex" },
    expectedVersion: CODEX_VERSION,
    stateDir: CODEX_STATE_DIR,
  },
  pi: {
    artifact: (architecture) => ({
      archive: {
        sha256: PI_CHECKSUMS[architecture],
        url: `https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-linux-${NPM_ARCHITECTURE[architecture]}.tar.gz`,
      },
      executable: "/opt/foundry/pi/pi",
      files: [
        { executable: true, member: "pi/pi", path: "/opt/foundry/pi/pi" },
        {
          executable: false,
          member: "pi/photon_rs_bg.wasm",
          path: "/opt/foundry/pi/photon_rs_bg.wasm",
        },
        {
          executable: false,
          member: "pi/package.json",
          path: "/opt/foundry/pi/package.json",
        },
      ],
      packageName: "@earendil-works/pi-coding-agent",
      version: PI_VERSION,
    }),
    env: (state, auth) => ({
      FOUNDRY_PI_API_KEY: auth.apiKey,
      PI_CODING_AGENT_DIR: `${state}/pi`,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    }),
    executor: {
      harness: "pi",
      model: "anthropic/claude-sonnet-4-5",
      provider: "pi",
    },
    expectedVersion: PI_VERSION,
    stateDir: "pi",
  },
};

export function isCliHarness(id: string | undefined): id is CliHarness {
  return CLI_HARNESS_IDS.some((harness) => harness === id);
}

export interface TurnExecutorRef {
  readonly harness: string;
  readonly model: string;
  readonly provider: string;
}

export const DIRECT_HARNESS = "direct";

export function harnessOf(provider: string): string {
  return isCliHarness(provider) ? provider : DIRECT_HARNESS;
}

export function isGuestArchitecture(name: string): name is GuestArchitecture {
  return Object.hasOwn(NPM_ARCHITECTURE, name);
}
