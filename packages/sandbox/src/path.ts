import { normalizePosixPath, resolvePosixPath } from "@foundry/lib/paths";

import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "./constants";
import { SandboxError } from "./errors";

const PATH_PREFIX = /^path/;

export function normalizeSandboxWorkingDirectory(path: string): string {
  if (!path.startsWith("/")) {
    throw new SandboxError(
      "invalid-contract",
      "sandbox working directory must be absolute",
      { details: { path } }
    );
  }
  try {
    return normalizePosixPath(path);
  } catch (error) {
    throw invalidPath(error, path, "sandbox working directory");
  }
}

/** Normalizes one sandbox-internal path without ever consulting the host. */
export function normalizeSandboxPath(
  path: string,
  workingDirectory = DEFAULT_SANDBOX_WORKING_DIRECTORY
): string {
  if (path.length === 0) {
    throw new SandboxError(
      "invalid-contract",
      "sandbox path must not be empty"
    );
  }
  const base = normalizeSandboxWorkingDirectory(workingDirectory);
  try {
    return resolvePosixPath(path, base);
  } catch (error) {
    throw invalidPath(error, path, "sandbox path");
  }
}

function invalidPath(
  error: unknown,
  path: string,
  label: string
): SandboxError {
  if (!(error instanceof TypeError)) {
    throw error;
  }
  return new SandboxError(
    "invalid-contract",
    error.message.replace(PATH_PREFIX, label),
    {
      details: { path },
    }
  );
}
