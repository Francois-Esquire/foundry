import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The files every extension GitHub release carries. */
const EXTENSION_ASSETS = ["prompts.vsix", "extension.json"] as const;

/** Which extension files a release still lacks; attached files are never replaced. */
export function missingExtensionAssets(assets: { name: string }[]): string[] {
  return EXTENSION_ASSETS.filter(
    (name) => !assets.some((asset) => asset.name === name)
  );
}

/**
 * Verify a VSIX and its `extension.json` record: a clean build of the
 * release commit, unchanged bytes, and the Marketplace identity and version.
 * Returns the archive's SHA-256 digest.
 */
export function verifyExtension(
  directory: string,
  version: string,
  sha: string
): string {
  const manifest = JSON.parse(
    readFileSync(join(directory, "extension.json"), "utf8")
  );
  if (
    manifest.archive !== "prompts.vsix" ||
    manifest.name !== "prompts" ||
    manifest.publisher !== "foundry-sh" ||
    manifest.version !== version ||
    manifest.sha !== sha
  ) {
    throw new Error("Extension artifact does not match the release");
  }
  if (manifest.clean !== true) {
    throw new Error("Extension artifact was built from uncommitted sources");
  }
  const archive = join(directory, "prompts.vsix");
  const digest = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  if (digest !== manifest.sha256) {
    throw new Error("Extension archive digest changed");
  }
  const extension = JSON.parse(
    execFileSync("unzip", ["-p", archive, "extension/package.json"], {
      encoding: "utf8",
    })
  );
  if (
    extension.name !== "prompts" ||
    extension.publisher !== "foundry-sh" ||
    extension.version !== version
  ) {
    throw new Error("VSIX identity does not match the release");
  }
  return digest;
}
