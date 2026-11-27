import type { ModelKind } from "@foundry/models";
import { z } from "zod";

export type ConfigurationErrorCode =
  | "CONFIGURATION_BUSY"
  | "CONFIGURATION_UNREADABLE"
  | "PROVIDER_ENTRY_INVALID"
  | "PROVIDER_ENVIRONMENT_CHANGED"
  | "PROVIDER_ID_TAKEN"
  | "PROVIDERS_NOT_CONFIGURED";

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

export class InvalidStoredConfiguration extends ConfigurationError {
  constructor(message: string) {
    super("CONFIGURATION_UNREADABLE", message);
  }
}

export interface ProviderEntryRecord {
  readonly defaults?: Partial<Record<ModelKind, string>>;
  readonly enabled: boolean;
  readonly id: string;
  readonly plugin: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

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

export interface ProviderConfigurations {
  readonly machine: ProvidersFile | undefined;
  readonly revision: number;
  workspace(id: string): ProvidersFile | undefined;
  readonly workspaces: readonly string[];
}

export interface ProviderWrites {
  readonly machine?: ProvidersFile;
  readonly workspace?: ProvidersFile;
}

export interface ProviderStore {
  identityKey(make: boolean): Promise<Uint8Array | undefined>;
  read(): Promise<ProviderConfigurations>;
  revision(): Promise<number>;
  update(
    workspace: string | undefined,
    edit: (current: ProviderConfigurations) => ProviderWrites
  ): Promise<ProviderConfigurations>;
}

export const MACHINE_SCOPE = "";

export function keptConfigurations(
  texts: ReadonlyMap<string, string>,
  revision: number
): ProviderConfigurations {
  const machineText = texts.get(MACHINE_SCOPE);
  let machine: { readonly file: ProvidersFile | undefined } | undefined;
  const parsed = new Map<string, ProvidersFile>();
  return {
    get machine() {
      machine ??= {
        file:
          machineText === undefined
            ? undefined
            : parseConfiguration(
                "the machine's provider configuration",
                machineText
              ),
      };
      return machine.file;
    },
    revision,
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

function configurationText(file: ProvidersFile): string {
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

export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "the file";
      return `${at}: ${issue.code.replaceAll("_", " ")}`;
    })
    .join("; ");
}

function unreadable(what: string, why: string): ConfigurationError {
  return new InvalidStoredConfiguration(
    `${what} cannot be read (${why}); configure those providers again`
  );
}

const KEY = /^[0-9a-f]{64}$/;

export function newIdentityKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function identityKeyFrom(text: string): Uint8Array {
  if (!KEY.test(text)) {
    throw new InvalidStoredConfiguration(
      "the identity key in the Marbles database is not one; remove it to start new sessions everywhere"
    );
  }
  return Uint8Array.from(text.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  );
}

export class MemoryProviderStore implements ProviderStore {
  readonly #texts = new Map<string, string>();
  #key: string | undefined;
  #revision = 0;

  identityKey(make: boolean): Promise<Uint8Array | undefined> {
    if (make) {
      this.#key ??= newIdentityKey();
    }
    return Promise.resolve(
      this.#key === undefined ? undefined : identityKeyFrom(this.#key)
    );
  }

  read(): Promise<ProviderConfigurations> {
    return Promise.resolve(
      keptConfigurations(new Map(this.#texts), this.#revision)
    );
  }

  revision(): Promise<number> {
    return Promise.resolve(this.#revision);
  }

  update(
    workspace: string | undefined,
    edit: (current: ProviderConfigurations) => ProviderWrites
  ): Promise<ProviderConfigurations> {
    try {
      const writes = edit(
        keptConfigurations(new Map(this.#texts), this.#revision)
      );
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

export function empty(): ProvidersFile {
  return { providers: [], version: 1 };
}
