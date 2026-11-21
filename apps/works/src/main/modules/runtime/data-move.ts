import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { hasErrorCode } from "@foundry/lib/atomic-file";
import { ModuleRuntimeError } from "./controller";

interface ModuleDataAdmission {
  readonly checkDatabase: (file: string) => Promise<void>;
  readonly from: string;
  readonly to: string;
}

export async function admitModuleData(
  data: ModuleDataAdmission
): Promise<void> {
  const staging = path.join(path.dirname(data.to), ".data-moving");
  const legacy = await lstat(data.from).catch(missing);
  const hasLegacy =
    legacy !== undefined &&
    (!legacy.isDirectory() ||
      legacy.isSymbolicLink() ||
      (await readdir(data.from)).length > 0);
  if (hasLegacy || (await lstat(staging).catch(missing)) !== undefined) {
    throw new ModuleRuntimeError(
      `Legacy Module data requires offline recovery. Works cannot prove that older Programs and database connections are closed. Close every Works version and database tool. Back up ${data.from}, ${data.to}, and ${staging} before changing them. Reconcile any copies and recover the complete data into ${data.to}, using a SQLite backup that includes WAL data. Verify the recovered database and files, then move the legacy directory and any staging directory aside as recovery copies before retrying. No files were changed.`
    );
  }
  const destination = await lstat(data.to).catch(missing);
  if (
    destination !== undefined &&
    (!destination.isDirectory() || destination.isSymbolicLink())
  ) {
    throw new ModuleRuntimeError(
      "The Module's data folder must be a real directory"
    );
  }
  for (const name of ["data.sqlite", "data.sqlite.bak"]) {
    const file = path.join(data.to, name);
    const entry = await lstat(file).catch(missing);
    if (entry !== undefined) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new ModuleRuntimeError(
          "A Module database must be a regular file"
        );
      }
      await data.checkDatabase(file);
    }
  }
}

function missing(error: unknown): undefined {
  if (!hasErrorCode(error, "ENOENT")) {
    throw error;
  }
}
