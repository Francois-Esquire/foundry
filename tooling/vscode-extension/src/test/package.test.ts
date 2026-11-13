import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const RELATIVE_PREFIX = /^\.\//;
const DEVELOPMENT_PATH = /node_modules|fixtures|scripts|media/;
const MARKDOWN_TARGET = /\]\(([^)\s]+)\)/g;
const IMAGE_TARGET = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const HTTPS = /^https:\/\//;
const RAW_PREFIX =
  "https://raw.githubusercontent.com/Francois-Esquire/foundry/";

const root = resolve(import.meta.dirname, "../..");
const archive = resolve(root, "dist/prompts.vsix");
const unzip = (...args: string[]) =>
  execFileSync("unzip", [...args], { encoding: "utf8" });

test("the installable VSIX has the Marketplace identity and only its runtime and listing files", () => {
  const workspace = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8")
  );
  const packaged = JSON.parse(unzip("-p", archive, "extension/package.json"));
  expect(packaged).toMatchObject({
    contributes: workspace.contributes,
    engines: workspace.engines,
    name: "prompts",
    publisher: "foundry-sh",
    version: workspace.version,
  });
  expect(packaged).not.toHaveProperty("devDependencies");
  expect(packaged).not.toHaveProperty("scripts");
  expect(packaged).not.toHaveProperty("private");
  const files = unzip("-Z1", archive).split("\n");
  for (const grammar of packaged.contributes.grammars) {
    expect(files).toContain(
      `extension/${grammar.path.replace(RELATIVE_PREFIX, "")}`
    );
  }
  expect(files).toContain("extension/LICENSE.txt");
  expect(files).toContain("extension/readme.md");
  // Release Please creates the changelog with the first release PR.
  expect(files.includes("extension/changelog.md")).toBe(
    existsSync(resolve(root, "CHANGELOG.md"))
  );
  expect(files.some((path) => DEVELOPMENT_PATH.test(path))).toBe(false);
});

test("the build record names this commit and the archive's exact bytes", () => {
  const record = JSON.parse(
    readFileSync(resolve(root, "dist/extension.json"), "utf8")
  );
  const workspace = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8")
  );
  expect(record).toMatchObject({
    archive: "prompts.vsix",
    name: "prompts",
    publisher: "foundry-sh",
    sha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
    version: workspace.version,
  });
  // Attachment rejects a dirty build, so CI fails before a release exists.
  expect(record.clean).toEqual(process.env.CI ? true : expect.any(Boolean));
});

test("the packaged README links only absolutely, with images pinned to the recorded commit", () => {
  const readme = unzip("-p", archive, "extension/readme.md");
  const { sha } = JSON.parse(
    readFileSync(resolve(root, "dist/extension.json"), "utf8")
  );
  const targets = [...readme.matchAll(MARKDOWN_TARGET)].map(([, url]) => url);
  expect(targets.length).toBeGreaterThan(0);
  for (const url of targets) {
    expect(url).toMatch(HTTPS);
  }
  const images = [...readme.matchAll(IMAGE_TARGET)].map(([, url]) => url);
  expect(images.length).toBeGreaterThan(0);
  for (const url of images) {
    expect(url?.startsWith(`${RAW_PREFIX}${sha}/`)).toBe(true);
    const path = url?.slice(`${RAW_PREFIX}${sha}/`.length) ?? "";
    expect(existsSync(resolve(root, "../..", path))).toBe(true);
  }
});
