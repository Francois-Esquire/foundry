import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Container } from "@foundry/sandbox/container/containers";
import { z } from "zod";

export type GuestHarness = "claude-code" | "codex";
const execute = promisify(execFile);
const manifestSchema = z.object({
  dist: z.object({
    integrity: z.string().startsWith("sha512-"),
    tarball: z.url(),
  }),
});

/** These are paired with the installed host SDK and tested app-server protocol. */
export function guestArtifact(harness: GuestHarness, architecture: string) {
  const architectures: Record<string, string> = {
    aarch64: "arm64",
    x86_64: "x64",
  };
  const arch = architectures[architecture.trim()];
  if (!arch) {
    throw new Error(`Unsupported guest architecture: ${architecture.trim()}`);
  }
  if (harness === "claude-code") {
    return {
      executable: "/opt/foundry/bin/claude",
      files: [
        {
          executable: true,
          member: "package/claude",
          path: "/opt/foundry/bin/claude",
        },
      ],
      member: "package/claude",
      packageName: `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
      version: "0.3.205",
    };
  }
  const prefix = `package/vendor/${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
  const members = [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-resources/bwrap",
    "codex-resources/zsh/bin/zsh",
    "codex-path/rg",
    "codex-package.json",
  ];
  return {
    executable: "/opt/foundry/bin/codex",
    files: members.map((member) => ({
      executable: member !== "codex-package.json",
      member: `${prefix}/${member}`,
      path: `/opt/foundry/${member}`,
    })),
    member: `package/vendor/${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl/bin/codex`,
    packageName: "@openai/codex",
    version: `0.144.6-linux-${arch}`,
  };
}

type GuestArtifact = ReturnType<typeof guestArtifact>;

/** Download on the host, verify npm integrity, and extract only the pinned runtime files. */
async function downloadGuestCli(
  artifact: GuestArtifact,
  signal: AbortSignal
): Promise<Readonly<Record<string, Uint8Array>>> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(artifact.packageName)}/${artifact.version}`,
    { signal }
  );
  if (!response.ok) {
    throw new Error(`CLI metadata fetch failed: HTTP ${response.status}`);
  }
  const { dist } = manifestSchema.parse(await response.json());
  const url = new URL(dist.tarball);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
    throw new Error("CLI archive must come from the npm registry.");
  }
  const archiveResponse = await fetch(url, { signal });
  if (!archiveResponse.ok) {
    throw new Error(`CLI archive fetch failed: HTTP ${archiveResponse.status}`);
  }
  const archive = new Uint8Array(await archiveResponse.arrayBuffer());
  if (
    `sha512-${createHash("sha512").update(archive).digest("base64")}` !==
    dist.integrity
  ) {
    throw new Error("CLI archive integrity check failed.");
  }
  const temporary = await mkdtemp(join(tmpdir(), "marbles-cli-"));
  try {
    const path = join(temporary, "cli.tgz");
    await writeFile(path, archive);
    await execute(
      "tar",
      [
        "-xzf",
        path,
        "-C",
        temporary,
        ...artifact.files.map((file) => file.member),
      ],
      { signal }
    );
    const files: Record<string, Uint8Array> = {};
    for (const file of artifact.files) {
      files[file.path] = await readFile(join(temporary, file.member));
    }
    return files;
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

export interface PreparedGuest {
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
}

/** Provision before the turn; credentials exist only in each child's environment. */
interface PrepareGuestOptions {
  apiKey?: string;
  download?: typeof downloadGuestCli;
  externalAuthentication?: boolean;
  harness: GuestHarness;
  oauthToken?: string;
  sessionId: string;
  signal: AbortSignal;
}

export async function prepareGuest(
  container: Container,
  options: PrepareGuestOptions
): Promise<PreparedGuest> {
  if (
    !(
      options.externalAuthentication ||
      options.apiKey?.trim() ||
      (options.harness === "claude-code" && options.oauthToken?.trim())
    )
  ) {
    throw new Error(
      `${options.harness} requires explicit per-session authentication.`
    );
  }
  const exec = async (argv: string[]) => {
    const result = await container.commands.exec(argv, {
      signal: options.signal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Guest preparation command failed (${argv[0]}, exit ${result.exitCode}).`
      );
    }
    return result.stdout;
  };
  const artifact = guestArtifact(options.harness, await exec(["uname", "-m"]));
  const state = `/var/lib/foundry/sessions/${createHash("sha256").update(options.sessionId).digest("hex")}`;
  await exec(["mkdir", "-p", "/opt/foundry/bin", state]);
  const exists = await container.commands.exec(
    ["sh", "-c", 'test -x "$1"', "check-cli", artifact.executable],
    { signal: options.signal }
  );
  const installed =
    exists.exitCode === 0
      ? await container.commands.exec([artifact.executable, "--version"], {
          signal: options.signal,
        })
      : { exitCode: 127, stdout: "" };
  const expectedVersion =
    options.harness === "claude-code" ? "2.1.205" : "0.144.6";
  const supportsPresent = await container.commands.exec(
    [
      "sh",
      "-c",
      'for file do test -r "$file" || exit 1; done',
      "check-files",
      ...artifact.files.map((file) => file.path),
    ],
    { signal: options.signal }
  );
  if (
    installed.exitCode !== 0 ||
    !installed.stdout.includes(expectedVersion) ||
    supportsPresent.exitCode !== 0
  ) {
    const files = await (options.download ?? downloadGuestCli)(
      artifact,
      options.signal
    );
    await container.files.copyIn(files);
    for (const file of artifact.files) {
      await exec(["chmod", file.executable ? "755" : "644", file.path]);
    }
    if (
      !(await exec([artifact.executable, "--version"])).includes(
        expectedVersion
      )
    ) {
      throw new Error(
        "Guest CLI version does not match the pinned host transport."
      );
    }
  }
  const environment = guestEnvironment(state, options);
  await exec(["mkdir", "-p", `${state}/claude`, `${state}/codex`]);
  return { environment, executable: artifact.executable };
}

function guestEnvironment(
  state: string,
  options: Pick<PrepareGuestOptions, "harness" | "apiKey" | "oauthToken">
): Readonly<Record<string, string>> {
  const environment = {
    HOME: state,
    LANG: "C.UTF-8",
    PATH: "/opt/foundry/bin:/opt/foundry/codex-path:/usr/local/bin:/usr/bin:/bin",
  };
  if (options.harness === "claude-code") {
    return {
      ...environment,
      CLAUDE_CONFIG_DIR: `${state}/claude`,
      ...(options.oauthToken
        ? { CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken }
        : { ANTHROPIC_API_KEY: options.apiKey ?? "" }),
    };
  }
  return {
    ...environment,
    CODEX_HOME: `${state}/codex`,
    ...(options.apiKey ? { OPENAI_API_KEY: options.apiKey } : {}),
  };
}
