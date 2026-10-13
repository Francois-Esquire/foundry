import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyFixture } from "../helpers/copy-fixture";

it("copies tracked fixture files while leaving ignored files and empty directories behind", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-copy-fixture-"));
  const source = join(root, "fixture");
  const destination = join(root, "copy");
  try {
    mkdirSync(source);
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "dist/\n.claude/\n");
    mkdirSync(join(source, ".foundry", "atlas"), { recursive: true });
    writeFileSync(
      join(source, ".foundry", "atlas", "config.ts"),
      "export default {};\n"
    );
    writeFileSync(join(source, "package.json"), '{"name":"fixture"}\n');
    execFileSync("git", ["add", "--", "fixture"], { cwd: root });
    mkdirSync(join(source, "packages", ".claude"), { recursive: true });
    mkdirSync(join(source, "packages", "dist"), { recursive: true });
    writeFileSync(join(source, "packages", "dist", "index.ts"), "export {};\n");

    copyFixture(source, destination);

    expect(readFileSync(join(destination, "package.json"), "utf8")).toBe(
      '{"name":"fixture"}\n'
    );
    expect(
      readFileSync(join(destination, ".foundry", "atlas", "config.ts"), "utf8")
    ).toBe("export default {};\n");
    expect(existsSync(join(destination, "packages"))).toBe(false);
    expect(existsSync(join(source, "packages", "dist", "index.ts"))).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
