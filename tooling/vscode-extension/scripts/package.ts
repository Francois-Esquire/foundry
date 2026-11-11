import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createVSIX } from "@vscode/vsce";
import { file } from "bun";

const root = resolve(import.meta.dirname, "..");
const staging = resolve(root, ".cache/vsix");
const output = resolve(root, "dist");
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8")
);
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
// Releases accept only an archive whose sources match the commit it records.
const clean = git("status", "--porcelain", "--", ".", "../../LICENSE") === "";

await rm(staging, { force: true, recursive: true });
await mkdir(staging, { recursive: true });
await mkdir(output, { recursive: true });
// README images resolve to the recorded commit on GitHub, so media stays out.
for (const path of [".vscodeignore", "README.md", "syntaxes"]) {
  await cp(resolve(root, path), resolve(staging, path), { recursive: true });
}
await cp(resolve(root, "../../LICENSE"), resolve(staging, "LICENSE"));
const changelog = file(resolve(root, "CHANGELOG.md"));
if (await changelog.exists()) {
  await cp(resolve(root, "CHANGELOG.md"), resolve(staging, "CHANGELOG.md"));
}
await writeFile(
  resolve(staging, "package.json"),
  `${JSON.stringify(
    {
      bugs: manifest.bugs,
      categories: manifest.categories,
      contributes: manifest.contributes,
      description: manifest.description,
      displayName: manifest.displayName,
      engines: manifest.engines,
      homepage: manifest.homepage,
      keywords: manifest.keywords,
      license: manifest.license,
      name: "prompts",
      preview: manifest.preview,
      publisher: manifest.publisher,
      repository: manifest.repository,
      version: manifest.version,
    },
    null,
    2
  )}\n`
);
const archive = "prompts.vsix";
await createVSIX({
  baseContentUrl: `https://github.com/Francois-Esquire/foundry/blob/${sha}/tooling/vscode-extension`,
  baseImagesUrl: `https://raw.githubusercontent.com/Francois-Esquire/foundry/${sha}/tooling/vscode-extension`,
  cwd: staging,
  dependencies: false,
  packagePath: resolve(output, archive),
});
const sha256 = createHash("sha256")
  .update(await readFile(resolve(output, archive)))
  .digest("hex");
await writeFile(
  resolve(output, "extension.json"),
  `${JSON.stringify({ archive, clean, name: "prompts", publisher: manifest.publisher, sha, sha256, version: manifest.version }, null, 2)}\n`
);
