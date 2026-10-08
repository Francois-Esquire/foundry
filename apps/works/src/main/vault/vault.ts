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

export interface VaultStores {
  secure: KeyValueStore;
  settings: KeyValueStore;
}

export interface VaultOptions {
  /** Environment consulted for fallbacks. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

export type VaultListener = (status: VaultStatus) => void;

/**
 * The credentials the app holds, warm in memory and persisted per tier. Values
 * only leave through resolve(); everything the renderer sees goes through
 * status(), which reports presence and source and never the value.
 */
export class Vault {
  readonly #stores: VaultStores;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #values = new Map<string, string>();
  readonly #listeners = new Set<VaultListener>();
  #encryption: VaultStatus["encryption"];
  #queue: Promise<void> = Promise.resolve();

  private constructor(
    stores: VaultStores,
    env: Readonly<Record<string, string | undefined>>,
    encryption: VaultStatus["encryption"]
  ) {
    this.#stores = stores;
    this.#env = env;
    this.#encryption = encryption;
  }

  /** Hydrate every registered field from its tier. */
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

    const vault = new Vault(stores, env, encryption);
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

  /** The value a consumer should use: store, then environment, then fallback. */
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

  /**
   * Store a value, or clear it with null or blank. The tier is written before
   * memory changes, so a failed write leaves the vault as it was and the error
   * reaches the caller. Mutations run in request order, including their no-op
   * checks and notifications.
   */
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
        // A secret just went through the encryptor, so it is usable again.
        this.#encryption = "available";
      }
    }
    this.#notify();
  }

  /** Observe every change. Returns the unsubscribe function. */
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
