import {
  type Authorization,
  AuthorizationDeniedError,
  type Principal,
  withPermit,
} from "@foundry/authorization";
import {
  type FieldState,
  findVaultField,
  VAULT_OWNERS,
  type VaultField,
  type VaultOwnerId,
  type VaultStatus,
  vaultStoreKey,
} from "~/shared/vault";
import { EncryptionUnavailableError } from "./secure-store";
import type { KeyValueStore } from "./store";

export const VAULT_CREDENTIAL_RELEASE_ACTION = "credential.release";

export interface VaultStores {
  secure: KeyValueStore;
  settings: KeyValueStore;
}

export interface VaultOptions {
  authorization?: Authorization;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface VaultReleaseInput {
  readonly invocationId: string;
  readonly key: string;
  readonly ownerId: VaultOwnerId;
  readonly principal: Principal;
  readonly signal?: AbortSignal;
}

export type VaultListener = (status: VaultStatus) => void;

export class Vault {
  readonly #authorization: Authorization | undefined;
  readonly #stores: VaultStores;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #values = new Map<string, string>();
  readonly #listeners = new Set<VaultListener>();
  #encryption: VaultStatus["encryption"];
  #queue: Promise<void> = Promise.resolve();

  private constructor(
    stores: VaultStores,
    env: Readonly<Record<string, string | undefined>>,
    encryption: VaultStatus["encryption"],
    authorization: Authorization | undefined
  ) {
    this.#stores = stores;
    this.#env = env;
    this.#encryption = encryption;
    this.#authorization = authorization;
  }

  static async open(
    stores: VaultStores,
    options: VaultOptions = {}
  ): Promise<Vault> {
    const env = options.env ?? process.env;
    let encryption: VaultStatus["encryption"] = "available";
    const loaded = new Map<string, string>();

    for (const owner of VAULT_OWNERS) {
      for (const field of owner.fields) {
        const storeKey = vaultStoreKey(owner.id, field.key);
        try {
          const value = await stores[field.tier].get(storeKey);
          if (value !== null) {
            loaded.set(storeKey, value);
          }
        } catch (error) {
          if (!(error instanceof EncryptionUnavailableError)) {
            throw error;
          }
          encryption = "unavailable";
        }
      }
    }

    const vault = new Vault(stores, env, encryption, options.authorization);
    for (const [key, value] of loaded) {
      vault.#values.set(key, value);
    }
    return vault;
  }

  status(): VaultStatus {
    const fields = {} as VaultStatus["fields"];
    for (const owner of VAULT_OWNERS) {
      const states: Record<string, FieldState> = {};
      for (const field of owner.fields) {
        states[field.key] = this.#state(owner.id, field);
      }
      fields[owner.id] = states;
    }
    return { encryption: this.#encryption, fields };
  }

  resolve(ownerId: VaultOwnerId, key: string): string | null {
    const match = findVaultField(ownerId, key);
    if (!match) {
      return null;
    }
    return (
      this.#values.get(vaultStoreKey(ownerId, key)) ??
      this.#envValue(match.field) ??
      match.field.fallback ??
      null
    );
  }

  release(input: VaultReleaseInput): Promise<string | null> {
    const match = findVaultField(input.ownerId, input.key);
    if (!match) {
      return Promise.resolve(null);
    }
    if (this.#authorization === undefined) {
      return Promise.reject(
        new AuthorizationDeniedError(
          "Vault credential release requires an Authorization control plane"
        )
      );
    }
    return withPermit(
      this.#authorization,
      {
        action: VAULT_CREDENTIAL_RELEASE_ACTION,
        principal: input.principal,
        target: vaultStoreKey(input.ownerId, input.key),
      },
      input.invocationId,
      () => Promise.resolve(this.resolve(input.ownerId, input.key)),
      {
        openPending: false,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }
    );
  }

  async set(
    ownerId: VaultOwnerId,
    key: string,
    value: string | null
  ): Promise<void> {
    const write = this.#queue.then(() => this.#set(ownerId, key, value));
    this.#queue = write.catch(() => undefined);
    await write;
  }

  async #set(
    ownerId: VaultOwnerId,
    key: string,
    value: string | null
  ): Promise<void> {
    const match = findVaultField(ownerId, key);
    if (!match) {
      throw new Error(`Unknown vault field ${ownerId}.${key}`);
    }
    const storeKey = vaultStoreKey(ownerId, key);
    const next = value?.trim() ?? "";
    const store = this.#stores[match.field.tier];

    if (next.length === 0) {
      if (!this.#values.has(storeKey)) {
        return;
      }
      await store.delete(storeKey);
      this.#values.delete(storeKey);
    } else {
      if (this.#values.get(storeKey) === next) {
        return;
      }
      await store.set(storeKey, next);
      this.#values.set(storeKey, next);
      if (match.field.tier === "secure") {
        this.#encryption = "available";
      }
    }
    this.#notify();
  }

  onChange(listener: VaultListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #state(ownerId: VaultOwnerId, field: VaultField): FieldState {
    if (this.#values.has(vaultStoreKey(ownerId, field.key))) {
      return { isSet: true, source: "store" };
    }
    if (this.#envValue(field) !== null) {
      return { isSet: true, source: "env" };
    }
    if (field.fallback !== undefined) {
      return { isSet: true, source: "default" };
    }
    return { isSet: false, source: "none" };
  }

  #envValue(field: VaultField): string | null {
    if (field.envVar === undefined) {
      return null;
    }
    const value = this.#env[field.envVar]?.trim() ?? "";
    return value.length > 0 ? value : null;
  }

  #notify(): void {
    const status = this.status();
    for (const listener of this.#listeners) {
      listener(status);
    }
  }
}
