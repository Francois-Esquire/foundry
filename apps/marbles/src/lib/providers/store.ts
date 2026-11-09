import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ModelKind } from "@foundry/models";
import { z } from "zod";
import { acquireLock } from "~/lib/state/locks";

export type ConfigurationErrorCode =
  | "CONFIGURATION_BUSY"
  | "CONFIGURATION_PARTIAL"
  | "CONFIGURATION_UNREADABLE"
  | "PROVIDER_ENTRY_INVALID"
  | "PROVIDER_ID_TAKEN"
  | "PROVIDERS_NOT_CONFIGURED";

/** Provider configuration that cannot be read, written, or used as asked. */
export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
  readonly code: ConfigurationErrorCode;

  constructor(
    code: ConfigurationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
  }
}

export interface ProviderEntryRecord {
  readonly defaults?: Partial<Record<ModelKind, string>>;
  readonly enabled: boolean;
  readonly id: string;
  readonly plugin: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

/** One scope's file. `order` appears only in a workspace file. */
export interface ProvidersFile {
  readonly order?: readonly string[];
  readonly providers: readonly ProviderEntryRecord[];
  readonly version: 1;
}

const FILE = z.object({
  order: z.array(z.string()).optional(),
  providers: z.array(
    z.object({
      defaults: z.record(z.string(), z.string()).optional(),
      enabled: z.boolean(),
      id: z.string(),
      plugin: z.string(),
      settings: z.record(z.string(), z.unknown()).optional(),
    })
  ),
  version: z.literal(1),
});

/** The file at `path`, or undefined when there is none. An unreadable one throws. */
export function readProvidersFile(path: string): ProvidersFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw unreadable(
      path,
      (error as NodeJS.ErrnoException).code ?? "it cannot be read"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // biome-ignore lint/style/useErrorCause: the parser's message can quote the file, which may hold a secret.
    throw unreadable(path, "it is not valid JSON");
  }
  const checked = FILE.safeParse(parsed);
  if (!checked.success) {
    throw unreadable(path, describeIssues(checked.error));
  }
  return checked.data as ProvidersFile;
}

/**
 * Where a value fails a schema, by path and kind only. Parser and schema
 * messages can quote the value, and a misplaced key is a secret.
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "the file";
      return `${at}: ${issue.code.replaceAll("_", " ")}`;
    })
    .join("; ");
}

function unreadable(path: string, why: string): ConfigurationError {
  return new ConfigurationError(
    "CONFIGURATION_UNREADABLE",
    `${path} cannot be read as provider configuration (${why}); fix or remove it`
  );
}

/**
 * Temp-and-rename with the file readable by its owner only. The temp file
 * is flushed before the rename and the directory after it, so a crash
 * leaves the old file or the new one.
 */
function writeProvidersFile(path: string, file: ProvidersFile): void {
  writeText(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** Flush a rename. A filesystem that cannot sync a directory is left to its own ordering. */
function syncDirectory(dir: string): void {
  const handle = openSync(dir, "r");
  try {
    fsyncSync(handle);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    closeSync(handle);
  }
}

function writeText(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    syncDirectory(dir);
  } finally {
    rmSync(temp, { force: true });
  }
}

const LOCK = "providers";
const ATTEMPTS = 20;
const RETRY_MS = 25;

/** One file an update edits under its lock. `edit` returns undefined to leave it as it is. */
export interface FileEdit {
  readonly edit: (
    current: ProvidersFile | undefined
  ) => ProvidersFile | undefined;
  readonly lockDir: string;
  readonly path: string;
}

/**
 * Edit one scope's file under its lock: re-read, apply `edit`, write. `edit`
 * may throw to refuse, and nothing is written then. A lock held for longer
 * than a brief retry fails `CONFIGURATION_BUSY`.
 */
export async function updateProvidersFile(
  path: string,
  lockDir: string,
  edit: FileEdit["edit"]
): Promise<void> {
  await updateProvidersFiles([{ edit, lockDir, path }]);
}

/**
 * Edit several files together: take every lock in the order given, re-read
 * each, run every edit, and only then write. When a write fails, the files
 * already written are put back as they were, so other processes never see
 * part of the change unless this process dies between two writes.
 */
export async function updateProvidersFiles(
  edits: readonly FileEdit[]
): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const locks = takeLocks(edits.map((each) => each.lockDir));
    if (locks) {
      try {
        const planned = edits.map((each) => ({
          next: each.edit(readProvidersFile(each.path)),
          path: each.path,
        }));
        writeAll(planned);
        return;
      } finally {
        for (const lock of locks.reverse()) {
          lock.release();
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  throw new ConfigurationError(
    "CONFIGURATION_BUSY",
    `${edits.map((each) => each.path).join(" and ")} ${edits.length > 1 ? "are" : "is"} being changed by another process; try again`
  );
}

/** Every lock, or none: a held one releases those already taken. */
function takeLocks(dirs: readonly string[]): { release(): void }[] | undefined {
  const taken: { release(): void }[] = [];
  for (const dir of dirs) {
    const lock = acquireLock(dir, LOCK);
    if (!("release" in lock)) {
      for (const each of taken.reverse()) {
        each.release();
      }
      return;
    }
    taken.push(lock);
  }
  return taken;
}

function writeAll(
  planned: readonly { next: ProvidersFile | undefined; path: string }[]
): void {
  const written: { path: string; previous: string | undefined }[] = [];
  try {
    for (const { next, path } of planned) {
      if (next === undefined) {
        continue;
      }
      // Recorded first: a write can fail after its rename.
      written.push({
        path,
        previous: existsSync(path) ? readFileSync(path, "utf8") : undefined,
      });
      writeProvidersFile(path, next);
    }
  } catch (error) {
    const stranded = written.reverse().flatMap(({ path, previous }) => {
      try {
        if (previous === undefined) {
          rmSync(path, { force: true });
        } else {
          writeText(path, previous);
        }
        return [];
      } catch {
        return [path];
      }
    });
    if (stranded.length > 0) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options argument.
      throw new ConfigurationError(
        "CONFIGURATION_PARTIAL",
        `A change to provider configuration failed, and ${stranded.join(" and ")} could not be put back; check ${stranded.length > 1 ? "them" : "it"} before editing again`,
        { cause: error }
      );
    }
    throw error;
  }
}

const KEY_FILE = "identity.key";
const KEY = /^[0-9a-f]{64}$/;

/**
 * The machine's key for instance identities, from `<dir>/identity.key`
 * (mode `0600`). It is created once: written and flushed under a temporary
 * name, then linked into place, so concurrent creators agree on one key and
 * a crash leaves either no key or a whole one. It is never rewritten.
 * Without a directory, or read-only with none yet, a key for this process
 * alone, so identities from it match nothing stored. A key file that is
 * malformed, unreadable, or cannot be created is refused with its path.
 */
export function identityKey(dir: string | undefined, readOnly = false): Buffer {
  if (dir === undefined) {
    return randomBytes(32);
  }
  const path = join(dir, KEY_FILE);
  const existing = readKey(path);
  if (existing || readOnly) {
    return existing ?? randomBytes(32);
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, randomBytes(32).toString("hex"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    syncDirectory(dir);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: the cause is passed in the options argument.
    throw new ConfigurationError(
      "CONFIGURATION_UNREADABLE",
      `the identity key ${path} cannot be created (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); check that the Marbles state root is writable`,
      { cause: error }
    );
  } finally {
    rmSync(temp, { force: true });
  }
  return readKey(path) as Buffer;
}

function readKey(path: string): Buffer | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") {
      return;
    }
    throw keyRefused(path, `it cannot be read: ${String(code)}`);
  }
  if (!KEY.test(text.trim())) {
    throw keyRefused(path, "it is not an identity key");
  }
  return Buffer.from(text.trim(), "hex");
}

function keyRefused(path: string, why: string): ConfigurationError {
  return new ConfigurationError(
    "CONFIGURATION_UNREADABLE",
    `the identity key ${path} cannot be used (${why}); restore it, or remove it to start new sessions everywhere`
  );
}
