import path from "node:path";
import { safeStorage } from "electron";
import { type Encryptor, SecureStore } from "./secure-store";
import { JsonFileStore } from "./store";
import { Vault, type VaultOptions } from "./vault";

function safeStorageEncryptor(): Encryptor {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    decrypt: (cipher) =>
      safeStorage.decryptString(Buffer.from(cipher, "base64")),
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
  };
}

export function openAppVault(
  userDataDir: string,
  options: VaultOptions = {}
): Promise<Vault> {
  return Vault.open(
    {
      secure: new SecureStore(
        new JsonFileStore(path.join(userDataDir, "vault.json")),
        safeStorageEncryptor()
      ),
      settings: new JsonFileStore(path.join(userDataDir, "settings.json")),
    },
    options
  );
}
