import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ContainerMount } from "../containers/driver";
import { SandboxError } from "../errors";

export interface ResolvedHostMount {
  readonly access: "read-only" | "read-write";
  readonly executable?: boolean;
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export async function resolveHostMountSpecs(
  mounts: readonly ContainerMount[],
  allowedRoots: readonly string[]
): Promise<readonly ResolvedHostMount[]> {
  if (mounts.length === 0) {
    return Object.freeze([]);
  }
  if (allowedRoots.length === 0) {
    throw new SandboxError(
      "invalid-contract",
      "Host directory mounts require a trusted host-root allowlist"
    );
  }
  const roots = await Promise.all(
    allowedRoots.map(async (root) => {
      if (!isAbsolute(root)) {
        throw new SandboxError(
          "invalid-contract",
          "Host mount roots must be absolute"
        );
      }
      return realpath(resolve(root));
    })
  );
  const resolved: ResolvedHostMount[] = [];
  for (const mount of mounts) {
    if (mount.source.kind !== "host-directory") {
      throw new SandboxError(
        "unsupported",
        `host mount resolver does not support "${mount.source.kind}" mount "${mount.id}"`
      );
    }
    if (!isAbsolute(mount.source.path)) {
      throw new SandboxError(
        "invalid-contract",
        `sandbox mount "${mount.id}" source must be absolute`
      );
    }
    const source = await realpath(resolve(mount.source.path));
    const metadata = await stat(source);
    if (!metadata.isDirectory()) {
      throw new SandboxError(
        "invalid-contract",
        `sandbox mount "${mount.id}" source must be a directory`
      );
    }
    if (!roots.some((root) => isWithin(root, source))) {
      throw new SandboxError(
        "invalid-contract",
        `sandbox mount "${mount.id}" escapes the trusted host roots`
      );
    }
    resolved.push(
      Object.freeze({
        access: mount.access,
        ...(mount.executable === undefined
          ? {}
          : { executable: mount.executable }),
        id: mount.id,
        source,
        target: mount.target,
      })
    );
  }
  return Object.freeze(resolved);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || !(path.startsWith("..") || isAbsolute(path));
}
