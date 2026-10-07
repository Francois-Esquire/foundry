import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Container } from "@foundry/sandbox/container/containers";
import { z } from "zod";
import {
  CLI_HARNESSES,
  type CliHarness,
  type GuestArtifact,
  type GuestAuth,
  isGuestArchitecture,
} from "~/lib/cli-harnesses";

const execute = promisify(execFile);
const manifestSchema = z.object({
  dist: z.object({
    integrity: z.string().startsWith("sha512-"),
    tarball: z.url(),
  }),
});

/** The pinned guest files for a CLI harness on the architecture `uname -m` printed. */
export function guestArtifact(
  harness: CliHarness,
  architecture: string
): GuestArtifact {
  const machine = architecture.trim();
  if (!isGuestArchitecture(machine)) {
    throw new Error(`Unsupported guest architecture: ${machine}`);
  }
  return CLI_HARNESSES[harness].artifact(machine);
}

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
interface PrepareGuestOptions<H extends CliHarness> {
  readonly auth: GuestAuth<H>;
  readonly download?: typeof downloadGuestCli;
  readonly harness: H;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export async function prepareGuest<H extends CliHarness>(
  container: Container,
  options: PrepareGuestOptions<H>
): Promise<PreparedGuest> {
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
  const descriptor = CLI_HARNESSES[options.harness];
  const artifact = guestArtifact(options.harness, await exec(["uname", "-m"]));
  const state = `/var/lib/foundry/sessions/${createHash("sha256").update(options.sessionId).digest("hex")}`;
  await exec([
    "mkdir",
    "-p",
    "/opt/foundry/bin",
    `${state}/${descriptor.stateDir}`,
  ]);
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
    !installed.stdout.includes(descriptor.expectedVersion) ||
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
        descriptor.expectedVersion
      )
    ) {
      throw new Error(
        "Guest CLI version does not match the pinned host transport."
      );
    }
  }
  return {
    environment: {
      HOME: state,
      LANG: "C.UTF-8",
      PATH: "/opt/foundry/bin:/opt/foundry/codex-path:/usr/local/bin:/usr/bin:/bin",
      ...descriptor.env(state, options.auth),
    },
    executable: artifact.executable,
  };
}
