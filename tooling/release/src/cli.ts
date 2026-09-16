import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  discoverWorkspaces,
  generateChangelog,
  packRelease,
  publicWorkspaces,
  releaseVersion,
  validateTag,
} from "./release";

const root = resolve(import.meta.dirname, "../../..");
const packages = publicWorkspaces(discoverWorkspaces(root));
const version = releaseVersion(packages);
const command = process.argv[2];
if (command === "check") {
  if (process.argv.includes("--tag")) {
    validateTag(version, process.env.REF_TYPE, process.env.RELEASE_TAG);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tag=v${version}\nprerelease=${version.includes("-")}\n`
    );
  }
  process.stdout.write(
    `${packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join("\n")}\n`
  );
} else if (command === "changelog") {
  await generateChangelog(root, packages);
} else if (command === "pack") {
  packRelease(root, packages);
} else {
  throw new Error("Expected check, changelog, or pack");
}
