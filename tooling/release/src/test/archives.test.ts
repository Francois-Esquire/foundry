import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  createReleaseArchives,
  createZipArchive,
  verifyReleaseArchives,
} from "../archives";

test("release archives use Bun's publish rules and preserve the executable", () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-release-test-"));
  try {
    mkdirSync(join(root, "dist"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        bin: { marbles: "dist/cli.js" },
        files: ["dist/**/*.js", "dist/**/*.d.ts", "CHANGELOG.md"],
        name: "@foundry.sh/marbles",
        private: false,
        scripts: { prepack: "exit 99" },
        version: "0.0.1",
      })
    );
    writeFileSync(join(root, "dist/cli.js"), "#!/usr/bin/env bun\n");
    chmodSync(join(root, "dist/cli.js"), 0o755);
    writeFileSync(join(root, "dist/cli.js.map"), "{}");
    for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) {
      writeFileSync(join(root, name), name);
    }
    writeFileSync(join(root, ".env"), "UNRELATED=excluded");
    writeFileSync(join(root, "unrelated.ts"), "export {};\n");
    const archives = createReleaseArchives(root);
    expect(archives.tarball.endsWith("foundry.sh-marbles-0.0.1.tgz")).toBe(
      true
    );
    expect(archives.zip.endsWith("foundry.sh-marbles-0.0.1.zip")).toBe(true);
    createZipArchive(relative(process.cwd(), archives.tarball), archives.zip);
    expect(
      verifyReleaseArchives({
        tarball: relative(process.cwd(), archives.tarball),
        zip: relative(process.cwd(), archives.zip),
      }).name
    ).toBe("@foundry.sh/marbles");
    expect(verifyReleaseArchives(archives)).toEqual({
      files: [
        "CHANGELOG.md",
        "dist/cli.js",
        "LICENSE",
        "package.json",
        "README.md",
      ],
      name: "@foundry.sh/marbles",
      version: "0.0.1",
    });

    // A second run must replace the ZIP, rather than retain stale entries.
    writeFileSync(join(root, "dist/stale.js"), "export {};\n");
    createReleaseArchives(root);
    rmSync(join(root, "dist/stale.js"));
    createReleaseArchives(root);
    expect(verifyReleaseArchives(archives).files).not.toContain(
      "dist/stale.js"
    );

    const extracted = join(root, "extracted");
    execFileSync("unzip", ["-q", archives.zip, "-d", extracted]);
    const cli = join(extracted, "package/dist/cli.js");
    expect(readFileSync(cli, "utf8")).toBe("#!/usr/bin/env bun\n");
    chmodSync(cli, 0o644);
    execFileSync("zip", ["-q", "-X", archives.zip, "package/dist/cli.js"], {
      cwd: extracted,
    });
    expect(() => verifyReleaseArchives(archives)).toThrow(
      "Archive contents differ"
    );
    chmodSync(cli, 0o755);
    writeFileSync(cli, "#!/usr/bin/env bun\n// changed\n");
    execFileSync("zip", ["-q", "-X", archives.zip, "package/dist/cli.js"], {
      cwd: extracted,
    });
    expect(() => verifyReleaseArchives(archives)).toThrow(
      "Archive contents differ"
    );
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.name = "@example/another-package";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(
      createReleaseArchives(root).tarball.endsWith(
        "example-another-package-0.0.1.tgz"
      )
    ).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}, 15_000);

test("the ZIP holds only the package's own files, never what a link points at", () => {
  const root = mkdtempSync(join(tmpdir(), "release-zip-link-test-"));
  try {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "not part of the package");
    mkdirSync(join(root, "package"));
    writeFileSync(join(root, "package/package.json"), "{}");
    symlinkSync(outside, join(root, "package/linked.txt"));
    const tarball = join(root, "linked.tgz");
    execFileSync("tar", ["-czf", tarball, "package"], { cwd: root });
    const zip = join(root, "linked.zip");

    expect(() => createZipArchive(tarball, zip)).toThrow(
      "Unexpected non-file in package: linked.txt"
    );
    expect(existsSync(zip)).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
