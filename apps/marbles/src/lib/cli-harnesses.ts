import type { TurnExecutorRef } from "@foundry/models";

/**
 * The CLI harnesses: vendor CLIs Marbles drives, on the host or installed in
 * a sandbox guest. Everything that differs between them is decided here, so
 * a host can list them and the rest of lib reads one table. The module has
 * no runtime imports: argument parsing reads the ids without loading models.
 */

/** In preference order: "first available" tries them in this order. */
export const CLI_HARNESS_IDS = ["claude-code", "codex", "pi"] as const;
export type CliHarness = (typeof CLI_HARNESS_IDS)[number];

/** A guest's machine name, as `uname -m` prints it. */
export type GuestArchitecture = "aarch64" | "x86_64";

/** npm's name for each guest architecture, used in package names. */
const NPM_ARCHITECTURE: Record<GuestArchitecture, "arm64" | "x64"> = {
  aarch64: "arm64",
  x86_64: "x64",
};

/** One file the guest needs, taken from the pinned runtime archive. */
export interface GuestFile {
  readonly executable: boolean;
  /** Its path inside the package archive. */
  readonly member: string;
  /** Where it is installed in the guest. */
  readonly path: string;
}

/** The pinned runtime a guest CLI is installed from. */
export interface GuestArtifact {
  /** A pinned standalone release when npm does not ship a self-contained binary. */
  readonly archive?: { readonly sha256: string; readonly url: string };
  /** The CLI's path in the guest. */
  readonly executable: string;
  readonly files: readonly GuestFile[];
  readonly packageName: string;
  readonly version: string;
}

/** A credential sent to the guest as an environment variable. */
interface ApiKeyAuth {
  readonly apiKey: string;
  readonly kind: "apiKey";
}

/** A Claude subscription token, read from the host's own login. */
interface ClaudeOauthAuth {
  readonly kind: "oauth";
  readonly token: string;
}

/** Codex subscription tokens; the host passes them over the app-server and keeps refreshing them. */
interface ChatgptAuth {
  readonly kind: "chatgpt";
  readonly tokens: {
    readonly accessToken: string;
    readonly chatgptAccountId: string;
  };
}

/** How each CLI harness can be authenticated in a guest. */
interface GuestAuthentication {
  readonly "claude-code": ApiKeyAuth | ClaudeOauthAuth;
  readonly codex: ApiKeyAuth | ChatgptAuth;
  readonly pi: ApiKeyAuth;
}

/** A guest session's credentials, resolved once on the host. */
export type GuestAuth<H extends CliHarness = CliHarness> =
  GuestAuthentication[H];

export interface CliHarnessDescriptor<H extends CliHarness> {
  /** The guest files for one architecture, from the pinned package. */
  artifact(architecture: GuestArchitecture): GuestArtifact;
  /** The guest environment for a session whose writable state is under `state`. */
  env(state: string, auth: GuestAuth<H>): Readonly<Record<string, string>>;
  /** The route a turn takes on this harness when the agent names no model. */
  readonly executor: TurnExecutorRef & { readonly harness: H };
  /** What `--version` prints for the CLI the host transport was tested against. */
  readonly expectedVersion: string;
  /** The CLI's own config folder, under the session's guest state. */
  readonly stateDir: string;
}

/**
 * The Claude Code CLI ships inside the Agent SDK's platform package, whose
 * version is not the CLI's; the two are paired by the SDK release.
 */
const CLAUDE_SDK_VERSION = "0.3.205";
const CLAUDE_CLI_VERSION = "2.1.205";
/** Codex's npm version is its CLI version, suffixed per platform. */
const CODEX_VERSION = "0.144.6";
const PI_VERSION = "1.3.0";
const PI_CHECKSUMS: Record<GuestArchitecture, string> = {
  aarch64: "7fd2ea14fca390ebf9f47438baaef07c4b3d13db7cc8e459831118391b7ea65b",
  x86_64: "24f5be328b66d4da36876296989501974f43ab8434fbb57c35c523a3ea505ded",
};

/** Each CLI's config folder under a session's guest state: its `stateDir`, which `env` points the CLI at. */
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

/** These are paired with the installed host SDK and tested app-server protocol. */
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

export function isGuestArchitecture(name: string): name is GuestArchitecture {
  return Object.hasOwn(NPM_ARCHITECTURE, name);
}
