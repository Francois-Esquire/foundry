import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { valid } from "semver";
import {
  createReleaseArchives,
  type ReleaseArchives,
  verifyReleaseArchives,
} from "./archives";

export interface DaemonTarget {
  readonly arch: "arm64" | "x64";
  readonly name: string;
  readonly os: "darwin" | "linux";
  readonly rustTarget: string;
}

export const DAEMON_DIRECTORY = "crates/marbles-daemon";
export const DAEMON_BINARY_NAME = "marbles-daemon";
export const DAEMON_RELEASE_PATHS = [
  DAEMON_DIRECTORY,
  "Cargo.toml",
  "Cargo.lock",
] as const;

export const DAEMON_TARGETS: readonly DaemonTarget[] = [
  {
    arch: "arm64",
    name: "@foundry.sh/marbles-daemon-darwin-arm64",
    os: "darwin",
    rustTarget: "aarch64-apple-darwin",
  },
  {
    arch: "x64",
    name: "@foundry.sh/marbles-daemon-darwin-x64",
    os: "darwin",
    rustTarget: "x86_64-apple-darwin",
  },
  {
    arch: "arm64",
    name: "@foundry.sh/marbles-daemon-linux-arm64",
    os: "linux",
    rustTarget: "aarch64-unknown-linux-musl",
  },
  {
    arch: "x64",
    name: "@foundry.sh/marbles-daemon-linux-x64",
    os: "linux",
    rustTarget: "x86_64-unknown-linux-musl",
  },
];

const PACKAGE_SECTION = /^\[package\]\s*$/m;
const NEXT_SECTION = /^\[/m;
const VERSION_LINE = /^\s*version\s*=\s*"([^"]+)"\s*$/m;
const EXECUTABLE_MODE = 0o755;
const HEADER_BYTES = 20;
const MACHO_MAGIC_LE = 0xcf_fa_ed_fe;
const MACHO_MAGIC_BE = 0xfe_ed_fa_cf;
const MACHO_CPU_TYPES: Readonly<Record<DaemonTarget["arch"], number>> = {
  arm64: 0x01_00_00_0c,
  x64: 0x01_00_00_07,
};
const ELF_MAGIC = 0x7f_45_4c_46;
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE = 1;
const ELF_DATA_BIG = 2;
const ELF_MACHINES: Readonly<Record<DaemonTarget["arch"], number>> = {
  arm64: 183,
  x64: 62,
};

export interface BuiltDaemonPackage {
  archive: string;
  directory: string;
  name: string;
  sha256: string;
  version: string;
  zip: string;
  zipSha256: string;
}

export function parseCargoVersion(toml: string): string {
  const start = PACKAGE_SECTION.exec(toml);
  if (!start) {
    throw new Error("Missing [package] section in Cargo.toml");
  }
  const rest = toml.slice(start.index + start[0].length);
  const next = NEXT_SECTION.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const match = VERSION_LINE.exec(section);
  const version = match?.[1];
  if (!version || valid(version) !== version) {
    throw new Error(`Invalid crate version in Cargo.toml: ${version ?? ""}`);
  }
  return version;
}

export function readDaemonVersion(root: string): string {
  return parseCargoVersion(
    readFileSync(join(root, DAEMON_DIRECTORY, "Cargo.toml"), "utf8")
  );
}

export function hostDaemonTarget(
  platform: string = process.platform,
  arch: string = process.arch
): DaemonTarget | undefined {
  return DAEMON_TARGETS.find(
    (target) => target.os === platform && target.arch === arch
  );
}

export function daemonPackageManifest(
  target: DaemonTarget,
  version: string
): Record<string, unknown> {
  return {
    bugs: {
      url: "https://github.com/Francois-Esquire/foundry/issues",
    },
    cpu: [target.arch],
    description: `Prebuilt marbles-daemon binary for ${target.os} (${target.arch})`,
    files: [`bin/${DAEMON_BINARY_NAME}`, "LICENSE"],
    homepage:
      "https://github.com/Francois-Esquire/foundry/tree/main/crates/marbles-daemon",
    license: "MIT",
    name: target.name,
    os: [target.os],
    private: false,
    publishConfig: {
      access: "public",
    },
    repository: {
      directory: DAEMON_DIRECTORY,
      type: "git",
      url: "git+https://github.com/Francois-Esquire/foundry.git",
    },
    version,
  };
}

function packDaemonTarget(options: {
  readonly binary: string;
  readonly destination: string;
  readonly licensePath: string;
  readonly target: DaemonTarget;
  readonly version: string;
}): ReleaseArchives {
  const { binary, destination, licensePath, target, version } = options;
  if (!(existsSync(binary) && statSync(binary).isFile())) {
    throw new Error(
      `Missing compiled daemon binary for ${target.name} (${target.rustTarget}) at ${binary}`
    );
  }
  const staging = mkdtempSync(join(tmpdir(), "release-daemon-"));
  try {
    mkdirSync(join(staging, "bin"), { recursive: true });
    const stagedBinary = join(staging, "bin", DAEMON_BINARY_NAME);
    copyFileSync(binary, stagedBinary);
    chmodSync(stagedBinary, EXECUTABLE_MODE);
    copyFileSync(licensePath, join(staging, "LICENSE"));
    writeFileSync(
      join(staging, "package.json"),
      `${JSON.stringify(daemonPackageManifest(target, version), null, 2)}\n`
    );
    return createReleaseArchives(staging, destination);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

function binaryFormatError(
  header: Buffer,
  target: DaemonTarget
): string | undefined {
  if (header.length < HEADER_BYTES) {
    return "the file is too short to be an executable";
  }
  if (target.os === "darwin") {
    const magic = header.readUInt32BE(0);
    if (magic !== MACHO_MAGIC_LE && magic !== MACHO_MAGIC_BE) {
      return "not a 64-bit Mach-O executable";
    }
    const cpu =
      magic === MACHO_MAGIC_LE
        ? header.readUInt32LE(4)
        : header.readUInt32BE(4);
    return cpu === MACHO_CPU_TYPES[target.arch]
      ? undefined
      : `Mach-O cputype 0x${cpu.toString(16)} does not match ${target.arch}`;
  }
  if (header.readUInt32BE(0) !== ELF_MAGIC) {
    return "not an ELF executable";
  }
  if (header.readUInt8(4) !== ELF_CLASS_64) {
    return "not a 64-bit ELF executable";
  }
  const data = header.readUInt8(5);
  if (data !== ELF_DATA_LITTLE && data !== ELF_DATA_BIG) {
    return "ELF byte order is invalid";
  }
  const machine =
    data === ELF_DATA_LITTLE
      ? header.readUInt16LE(18)
      : header.readUInt16BE(18);
  return machine === ELF_MACHINES[target.arch]
    ? undefined
    : `ELF e_machine ${String(machine)} does not match ${target.arch}`;
}

function assertBinaryFormat(binary: string, target: DaemonTarget): void {
  const header = readFileSync(binary).subarray(0, HEADER_BYTES);
  const problem = binaryFormatError(header, target);
  if (problem !== undefined) {
    throw new Error(
      `Daemon binary in ${target.name} is invalid: ${problem} (${target.os}-${target.arch})`
    );
  }
}

function assertDaemonArchiveContents(
  tarball: string,
  target: DaemonTarget,
  version: string
): void {
  const staging = mkdtempSync(join(tmpdir(), "release-daemon-check-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", staging], {
      encoding: "utf8",
    });
    const root = join(staging, "package");
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8")
    );
    if (
      manifest.name !== target.name ||
      manifest.version !== version ||
      manifest.private === true ||
      JSON.stringify(manifest.os) !== JSON.stringify([target.os]) ||
      JSON.stringify(manifest.cpu) !== JSON.stringify([target.arch])
    ) {
      throw new Error(
        `Daemon package manifest mismatch for ${target.name}@${version}`
      );
    }
    const binary = join(root, "bin", DAEMON_BINARY_NAME);
    if (!existsSync(binary)) {
      throw new Error(`Missing bin/${DAEMON_BINARY_NAME} in ${target.name}`);
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX execute permission bit
    const mode = statSync(binary).mode & 0o777;
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX execute permission check
    if ((mode & 0o111) !== 0o111 || statSync(binary).size === 0) {
      throw new Error(
        `Daemon binary in ${target.name} must be non-empty and executable (mode ${mode.toString(8)})`
      );
    }
    assertBinaryFormat(binary, target);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

export function smokeTestHostDaemonTarball(
  tarball: string,
  target: DaemonTarget,
  version: string
): void {
  const staging = mkdtempSync(join(tmpdir(), "release-daemon-smoke-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", staging], {
      encoding: "utf8",
    });
    const binary = join(staging, "package", "bin", DAEMON_BINARY_NAME);
    const output = execFileSync(binary, ["--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (!output.includes(`marbles-daemon ${version}`)) {
      throw new Error(
        `Unexpected --help output from ${target.name}, expected marbles-daemon ${version}: ${output.slice(0, 120)}`
      );
    }
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

export function verifyDaemonArchives(options: {
  readonly archives: readonly ReleaseArchives[];
  readonly destination: string;
  readonly smokeTest?: boolean;
  readonly version: string;
}): BuiltDaemonPackage[] {
  const { archives, destination, smokeTest = true, version } = options;
  if (archives.length !== DAEMON_TARGETS.length) {
    throw new Error(
      `Expected ${String(DAEMON_TARGETS.length)} daemon archives, got ${String(archives.length)}`
    );
  }
  const host = hostDaemonTarget();
  return DAEMON_TARGETS.map((target, index) => {
    const archive = archives[index];
    if (!archive) {
      throw new Error(`Missing archives for ${target.name}`);
    }
    const identity = verifyReleaseArchives(archive);
    if (identity.name !== target.name || identity.version !== version) {
      throw new Error(
        `Daemon archive identity differs from ${target.name}@${version}`
      );
    }
    assertDaemonArchiveContents(archive.tarball, target, version);
    if (smokeTest && host?.name === target.name) {
      smokeTestHostDaemonTarball(archive.tarball, target, version);
    }
    return {
      archive: relative(destination, archive.tarball),
      directory: DAEMON_DIRECTORY,
      name: identity.name,
      sha256: createHash("sha256")
        .update(readFileSync(archive.tarball))
        .digest("hex"),
      version: identity.version,
      zip: relative(destination, archive.zip),
      zipSha256: createHash("sha256")
        .update(readFileSync(archive.zip))
        .digest("hex"),
    };
  });
}

export function packDaemonPackages(options: {
  readonly binariesDir: string;
  readonly destination: string;
  readonly root: string;
  readonly smokeTest?: boolean;
  readonly startIndex?: number;
  readonly version?: string;
}): BuiltDaemonPackage[] {
  const {
    binariesDir,
    destination,
    root,
    smokeTest = true,
    startIndex = 0,
  } = options;
  const version = options.version ?? readDaemonVersion(root);
  const licensePath = join(root, "LICENSE");
  const archives = DAEMON_TARGETS.map((target, index) =>
    packDaemonTarget({
      binary: join(binariesDir, target.rustTarget, DAEMON_BINARY_NAME),
      destination: join(
        destination,
        "packages",
        String(startIndex + index).padStart(3, "0")
      ),
      licensePath,
      target,
      version,
    })
  );
  return verifyDaemonArchives({ archives, destination, smokeTest, version });
}
