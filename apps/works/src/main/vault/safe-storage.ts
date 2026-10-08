import path from "node:path";
import { safeStorage } from "electron";
import { type Encryptor, SecureStore } from "./secure-store";
import { JsonFileStore } from "./store";
import { Vault } from "./vault";

/**
 * Electron's safeStorage: the OS keychain on macOS, DPAPI on Windows, and
 * libsecret or kwallet on Linux. Ciphertext is base64 so it sits in JSON.
 * Only meaningful after app.whenReady().
 */
function safeStorageEncryptor(): Encryptor {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    decrypt: (cipher) =>
      safeStorage.decryptString(Buffer.from(cipher, "base64")),
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
  };
}

/**
 * The app's vault on disk: secrets in vault.json as keychain-encrypted
 * ciphertext, plain settings in settings.json, both under the user data
 * directory.
 */
export function openAppVault(userDataDir: string): Promise<Vault> {
  return Vault.open({
    secure: new SecureStore(
      new JsonFileStore(path.join(userDataDir, "vault.json")),
      safeStorageEncryptor()
    ),
    settings: new JsonFileStore(path.join(userDataDir, "settings.json")),
  });
}
