import type { KeyValueStore } from "./store";

export interface Encryptor {
  available(): boolean;
  decrypt(cipher: string): string;
  encrypt(plain: string): string;
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super("OS-level encryption is not available, so secrets cannot be used");
    this.name = "EncryptionUnavailableError";
  }
}

export class SecureStore implements KeyValueStore {
  readonly #backing: KeyValueStore;
  readonly #encryptor: Encryptor;

  constructor(backing: KeyValueStore, encryptor: Encryptor) {
    this.#backing = backing;
    this.#encryptor = encryptor;
  }

  delete(key: string): Promise<void> {
    return this.#backing.delete(key);
  }

  async get(key: string): Promise<string | null> {
    this.#assertAvailable();
    const cipher = await this.#backing.get(key);
    if (cipher === null) {
      return null;
    }
    try {
      return this.#encryptor.decrypt(cipher);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.#assertAvailable();
    await this.#backing.set(key, this.#encryptor.encrypt(value));
  }

  #assertAvailable(): void {
    if (!this.#encryptor.available()) {
      throw new EncryptionUnavailableError();
    }
  }
}
