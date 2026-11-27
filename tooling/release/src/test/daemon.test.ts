import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  DAEMON_BINARY_NAME,
  DAEMON_DIRECTORY,
  DAEMON_TARGETS,
  type DaemonTarget,
  daemonPackageManifest,
  hostDaemonTarget,
  packDaemonPackages,
  parseCargoVersion,
  smokeTestHostDaemonTarball,
} from "../daemon";
import { packDaemonRelease, packRelease, type Workspace } from "../release";

const HEADER_BYTES = 64;

function binaryHeader(target: DaemonTarget): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  if (target.os === "darwin") {
    header.writeUInt32BE(0xcf_fa_ed_fe, 0);
    header.writeUInt32LE(
      target.arch === "arm64" ? 0x01_00_00_0c : 0x01_00_00_07,
      4
    );
    return header;
  }
  header.writeUInt32BE(0x7f_45_4c_46, 0);
  header[4] = 2;
  header[5] = 1;
  header[6] = 1;
  header.writeUInt16LE(target.arch === "arm64" ? 183 : 62, 18);
  return header;
}

function fakeDaemonTree(
  root: string,
  version: string,
  headerFor: (target: DaemonTarget) => Buffer = binaryHeader
): string {
  mkdirSync(join(root, DAEMON_DIRECTORY), { recursive: true });
  writeFileSync(
    join(root, DAEMON_DIRECTORY, "Cargo.toml"),
    `[package]\nname = "marbles-daemon"\nversion = "${version}"\n\n[dependencies]\nserde = "1"\n`
  );
  writeFileSync(join(root, "LICENSE"), "MIT License\n");
  const binariesDir = join(root, "binaries");
  for (const target of DAEMON_TARGETS) {
    const dir = join(binariesDir, target.rustTarget);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DAEMON_BINARY_NAME), headerFor(target), {
      mode: 0o755,
    });
  }
  return binariesDir;
}

test("parseCargoVersion reads only the [package] version and rejects invalid versions", () => {
  expect(
    parseCargoVersion(
      '[package]\nname = "marbles-daemon"\nversion = "0.1.2"\n\n[dependencies]\nserde = { version = "1.0.0" }\n'
    )
  ).toBe("0.1.2");
  expect(() =>
    parseCargoVersion('[dependencies]\nversion = "1.0.0"\n')
  ).toThrow("Missing [package]");
  expect(() =>
    parseCargoVersion('[package]\nname = "x"\nversion = "01.0.0"\n')
  ).toThrow("Invalid crate version");
});

test("daemonPackageManifest constrains os and cpu and marks the package public", () => {
  for (const target of DAEMON_TARGETS) {
    const manifest = daemonPackageManifest(target, "0.2.0");
    expect(manifest).toMatchObject({
      cpu: [target.arch],
      files: ["bin/marbles-daemon", "LICENSE"],
      name: target.name,
      os: [target.os],
      private: false,
      publishConfig: { access: "public" },
      version: "0.2.0",
    });
  }
  expect(hostDaemonTarget("darwin", "arm64")?.name).toBe(
    "@foundry.sh/marbles-daemon-darwin-arm64"
  );
  expect(hostDaemonTarget("linux", "x64")?.name).toBe(
    "@foundry.sh/marbles-daemon-linux-x64"
  );
  expect(hostDaemonTarget("win32", "x64")).toBeUndefined();
});

test("packDaemonRelease builds verified executable tarballs and zips for all four targets", () => {
  const root = mkdtempSync(join(tmpdir(), "release-daemon-pack-"));
  try {
    const binariesDir = fakeDaemonTree(root, "0.0.1");
    const digests = packDaemonRelease(root, binariesDir, "0.0.1", false);
    expect(digests).toHaveLength(DAEMON_TARGETS.length);
    const artifacts = JSON.parse(
      readFileSync(join(root, ".cache/release/packages.json"), "utf8")
    ) as { archive: string; name: string; version: string; zip: string }[];
    expect(artifacts.map(({ name }) => name)).toEqual(
      DAEMON_TARGETS.map(({ name }) => name)
    );
    expect(artifacts.every(({ version }) => version === "0.0.1")).toBe(true);
    const listing = execFileSync(
      "tar",
      ["-tzf", join(root, ".cache/release", artifacts[0]?.archive ?? "")],
      { encoding: "utf8" }
    );
    expect(listing).toContain("package/bin/marbles-daemon");
    expect(listing).toContain("package/LICENSE");
    expect(listing).toContain("package/package.json");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("packRelease passes daemon tarballs in PACKAGE_TARBALLS to consumer checks", () => {
  const root = mkdtempSync(join(tmpdir(), "release-combined-pack-"));
  try {
    const binariesDir = fakeDaemonTree(root, "0.0.1");
    const appDir = "apps/example";
    mkdirSync(join(root, appDir), { recursive: true });
    const app: Workspace = {
      directory: appDir,
      manifest: {
        name: "@foundry.sh/example",
        private: false,
        scripts: {
          "test:package":
            'bun -e \'const tarballs = JSON.parse(process.env.PACKAGE_TARBALLS); if (!tarballs["@foundry.sh/marbles-daemon-linux-x64"] || !tarballs["@foundry.sh/example"]) process.exit(1);\'',
        },
        version: "0.0.4",
      },
    };
    writeFileSync(
      join(root, appDir, "package.json"),
      JSON.stringify(app.manifest)
    );
    const digests = packRelease(root, [app], {
      daemonBinariesDir: binariesDir,
      smokeTestDaemon: false,
    });
    expect(digests).toHaveLength(DAEMON_TARGETS.length + 1);
    const artifacts = JSON.parse(
      readFileSync(join(root, ".cache/release/packages.json"), "utf8")
    ) as { name: string }[];
    expect(artifacts.map(({ name }) => name)).toEqual([
      ...DAEMON_TARGETS.map(({ name }) => name),
      "@foundry.sh/example",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("packDaemonPackages refuses missing platform binaries", () => {
  const root = mkdtempSync(join(tmpdir(), "release-daemon-missing-"));
  try {
    const binariesDir = fakeDaemonTree(root, "0.0.1");
    rmSync(
      join(binariesDir, DAEMON_TARGETS[0]?.rustTarget ?? "", DAEMON_BINARY_NAME)
    );
    expect(() =>
      packDaemonPackages({
        binariesDir,
        destination: join(root, ".cache/release"),
        root,
      })
    ).toThrow("Missing compiled daemon binary");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function swappedHeader(target: DaemonTarget): Buffer {
  const other = DAEMON_TARGETS.find(
    (candidate) => candidate.os === target.os && candidate.arch !== target.arch
  );
  return binaryHeader(other ?? target);
}

function foreignFormatHeader(target: DaemonTarget): Buffer {
  const other = DAEMON_TARGETS.find((candidate) => candidate.os !== target.os);
  return binaryHeader(other ?? target);
}

test("packDaemonPackages rejects a binary built for the wrong architecture", () => {
  for (const wrong of [swappedHeader, foreignFormatHeader]) {
    const root = mkdtempSync(join(tmpdir(), "release-daemon-arch-"));
    try {
      const binariesDir = fakeDaemonTree(root, "0.0.1", wrong);
      expect(() =>
        packDaemonPackages({
          binariesDir,
          destination: join(root, ".cache/release"),
          root,
          smokeTest: false,
        })
      ).toThrow("is invalid");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("packDaemonPackages rejects text files and truncated headers", () => {
  for (const bytes of [
    Buffer.from("#!/bin/sh\necho hi\n"),
    binaryHeader(DAEMON_TARGETS[0] as DaemonTarget).subarray(0, 8),
  ]) {
    const root = mkdtempSync(join(tmpdir(), "release-daemon-text-"));
    try {
      const binariesDir = fakeDaemonTree(root, "0.0.1", () => bytes);
      expect(() =>
        packDaemonPackages({
          binariesDir,
          destination: join(root, ".cache/release"),
          root,
          smokeTest: false,
        })
      ).toThrow("is invalid");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

function scriptTarball(root: string, output: string): string {
  const staging = join(root, "staging");
  mkdirSync(join(staging, "package", "bin"), { recursive: true });
  writeFileSync(
    join(staging, "package", "bin", DAEMON_BINARY_NAME),
    `#!/bin/sh\necho "${output}"\n`,
    { mode: 0o755 }
  );
  const tarball = join(root, "daemon.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", staging, "package"]);
  return tarball;
}

test("the host smoke test requires the exact crate version in --help", () => {
  const root = mkdtempSync(join(tmpdir(), "release-daemon-smoke-"));
  try {
    const target = hostDaemonTarget();
    if (!target) {
      return;
    }
    const tarball = scriptTarball(root, "marbles-daemon 0.0.1");
    expect(() =>
      smokeTestHostDaemonTarball(tarball, target, "0.0.1")
    ).not.toThrow();
    expect(() => smokeTestHostDaemonTarball(tarball, target, "0.0.2")).toThrow(
      "expected marbles-daemon 0.0.2"
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
