import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function providerInstalled(packageName: string): boolean {
  try {
    return existsSync(fileURLToPath(import.meta.resolve(packageName)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}
