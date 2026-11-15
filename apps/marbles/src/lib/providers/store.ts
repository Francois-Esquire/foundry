import { randomBytes } from "node:crypto";
import type { ModelKind } from "@foundry/models";
import { z } from "zod";

export type ConfigurationErrorCode =
  | "CONFIGURATION_BUSY"
  | "CONFIGURATION_UNREADABLE"
  | "PROVIDER_ENTRY_INVALID"
  | "PROVIDER_ENVIRONMENT_CHANGED"
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

/** One scope's configuration. `order` appears only in a workspace's. */
export interface ProvidersFile {
  readonly order?: readonly string[];
  readonly providers: readonly ProviderEntryRecord[];
  readonly version: 1;
}

const SCOPE_CONFIGURATION = z.object({
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

/**
 * Every scope's provider configuration as it is kept: the machine's, and
 * that of each workspace that keeps one of its own. A workspace's is read
 * only when asked for, so one that cannot be read refuses only what needs
 * it.
 */
export interface ProviderConfigurations {
  readonly machine: ProvidersFile | undefined;
  /** The configuration the workspace `id` keeps; `CONFIGURATION_UNREADABLE` when it cannot be read. */
  workspace(id: string): ProvidersFile | undefined;
  /** The ids of the workspaces that keep configuration of their own. */
  readonly workspaces: readonly string[];
}

/** What one edit writes: a scope it leaves out stays as it is. */
export interface ProviderWrites {
  readonly machine?: ProvidersFile;
  readonly workspace?: ProvidersFile;
}

/**
 * Where provider configuration is kept: the Marbles database's for a host
 * (`database/providers.ts`), memory for a programmatic one. Everything a
 * store hands back is a copy.
 */
export interface ProviderStore {
  /**
   * The machine's key for instance identities: made by the first call
   * with `make` and never rewritten; undefined, without `make`, while there
   * is none. A key that cannot be used throws `CONFIGURATION_UNREADABLE`.
   */
  identityKey(make: boolean): Promise<Buffer | undefined>;
  /** Every scope as kept now. A machine configuration that cannot be read throws. */
  read(): Promise<ProviderConfigurations>;
  /** A number that grows with every write to any scope, cheap to read: how a change elsewhere is noticed. */
  revision(): Promise<number>;
  /**
   * In one transaction: read every scope, run `edit` on them, and write
   * what it returns for the machine and for the workspace `workspace`;
   * resolve with every scope as it then stands. `edit` may throw to
   * refuse, and nothing is written then. A store that cannot take the
   * write before its wait runs out throws `CONFIGURATION_BUSY`.
   */
  update(
    workspace: string | undefined,
    edit: (current: ProviderConfigurations) => ProviderWrites
  ): Promise<ProviderConfigurations>;
}

/** The scope key a store keeps the machine's configuration under; a workspace's is its id. */
export const MACHINE_SCOPE = "";

/**
 * Configuration as a store keeps it, each scope's as JSON text by its
 * scope key (`MACHINE_SCOPE`, or a workspace id), read through the
 * configuration's schema. A scope that does not read refuses with where
 * and why, never with what it holds: a misplaced key is a secret.
 */
export function keptConfigurations(
  texts: ReadonlyMap<string, string>
): ProviderConfigurations {
  const machineText = texts.get(MACHINE_SCOPE);
  const machine =
    machineText === undefined
      ? undefined
      : parseConfiguration("the machine's provider configuration", machineText);
  const parsed = new Map<string, ProvidersFile>();
  return {
    machine,
    workspace(id) {
      const text = id === MACHINE_SCOPE ? undefined : texts.get(id);
      if (text === undefined) {
        return;
      }
      const known = parsed.get(id);
      if (known !== undefined) {
        return known;
      }
      const file = parseConfiguration(
        `the provider configuration of workspace ${id}`,
        text
      );
      parsed.set(id, file);
      return file;
    },
    workspaces: [...texts.keys()].filter((key) => key !== MACHINE_SCOPE),
  };
}

/** One scope's configuration as the JSON text a store keeps, checked against the schema first. */
export function configurationText(file: ProvidersFile): string {
  const checked = SCOPE_CONFIGURATION.safeParse(file);
  if (!checked.success) {
    throw new ConfigurationError(
      "PROVIDER_ENTRY_INVALID",
      `the provider configuration cannot be kept as it is (${describeIssues(checked.error)})`
    );
  }
  return JSON.stringify(checked.data);
}

function parseConfiguration(what: string, text: string): ProvidersFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // biome-ignore lint/style/useErrorCause: the parser's message can quote the configuration, which may hold a secret.
    throw unreadable(what, "it is not valid JSON");
  }
  const checked = SCOPE_CONFIGURATION.safeParse(parsed);
  if (!checked.success) {
    throw unreadable(what, describeIssues(checked.error));
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

function unreadable(what: string, why: string): ConfigurationError {
  return new ConfigurationError(
    "CONFIGURATION_UNREADABLE",
    `${what} cannot be read (${why}); configure those providers again`
  );
}

const KEY = /^[0-9a-f]{64}$/;

/** A new identity key, as the hex a store keeps. */
export function newIdentityKey(): string {
  return randomBytes(32).toString("hex");
}

/** The identity key a store kept as `text`; `CONFIGURATION_UNREADABLE` when it is not one. */
export function identityKeyFrom(text: string): Buffer {
  if (!KEY.test(text)) {
    throw new ConfigurationError(
      "CONFIGURATION_UNREADABLE",
      "the identity key in the Marbles database is not one; remove it to start new sessions everywhere"
    );
  }
  return Buffer.from(text, "hex");
}

/**
 * Provider configuration in this process's memory, as long as it lasts:
 * for a programmatic host, whose sessions match nothing kept elsewhere.
 */
export class MemoryProviderStore implements ProviderStore {
  readonly #texts = new Map<string, string>();
  #key: string | undefined;
  #revision = 0;

  identityKey(make: boolean): Promise<Buffer | undefined> {
    if (make) {
      this.#key ??= newIdentityKey();
    }
    return Promise.resolve(
      this.#key === undefined ? undefined : identityKeyFrom(this.#key)
    );
  }

  read(): Promise<ProviderConfigurations> {
    return Promise.resolve(keptConfigurations(new Map(this.#texts)));
  }

  revision(): Promise<number> {
    return Promise.resolve(this.#revision);
  }

  update(
    workspace: string | undefined,
    edit: (current: ProviderConfigurations) => ProviderWrites
  ): Promise<ProviderConfigurations> {
    try {
      const writes = edit(keptConfigurations(new Map(this.#texts)));
      const written = writtenTexts(workspace, writes);
      for (const [scope, text] of written) {
        this.#texts.set(scope, text);
      }
      if (written.size > 0) {
        this.#revision += 1;
      }
      return this.read();
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

/** What `writes` puts, by scope key; a workspace's only when there is one. */
export function writtenTexts(
  workspace: string | undefined,
  writes: ProviderWrites
): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  if (writes.machine !== undefined) {
    texts.set(MACHINE_SCOPE, configurationText(writes.machine));
  }
  if (writes.workspace !== undefined) {
    if (workspace === undefined) {
      throw new ConfigurationError(
        "PROVIDER_ENTRY_INVALID",
        "this engine hosts no workspace, so it has no workspace scope"
      );
    }
    texts.set(workspace, configurationText(writes.workspace));
  }
  return texts;
}

/**
 * `store` read as it is, with every write kept by this view alone: a dry
 * run's. It never makes an identity key.
 */
export function readOnlyProviders(store: ProviderStore): ProviderStore {
  const own = new Map<string, string>();
  let writes = 0;
  const read = async (): Promise<ProviderConfigurations> => {
    const kept = await store.read();
    if (own.size === 0) {
      return kept;
    }
    const texts = new Map<string, string>();
    if (kept.machine !== undefined) {
      texts.set(MACHINE_SCOPE, configurationText(kept.machine));
    }
    for (const id of kept.workspaces) {
      const file = kept.workspace(id);
      if (file !== undefined) {
        texts.set(id, configurationText(file));
      }
    }
    for (const [scope, text] of own) {
      texts.set(scope, text);
    }
    return keptConfigurations(texts);
  };
  return {
    identityKey: () => store.identityKey(false),
    read,
    revision: async () => (await store.revision()) + writes,
    async update(workspace, edit) {
      const written = writtenTexts(workspace, edit(await read()));
      for (const [scope, text] of written) {
        own.set(scope, text);
      }
      writes += written.size > 0 ? 1 : 0;
      return read();
    },
  };
}

export function empty(): ProvidersFile {
  return { providers: [], version: 1 };
}
