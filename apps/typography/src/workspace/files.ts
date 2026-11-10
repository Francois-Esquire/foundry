/** Getting files in from the browser and back out to it. */
import type { ImportFile } from "./importing";

/** Reads dropped or chosen files, in the order given. */
export const readFiles = (files: Iterable<File>): Promise<ImportFile[]> =>
  Promise.all(
    [...files].map(async (file) => ({
      bytes: new Uint8Array(await file.arrayBuffer()),
      name: file.name,
    }))
  );

const REVOKE_AFTER_MS = 60_000;

/** Offers the bytes to the person as a download named `fileName`. */
export const saveBytes = (fileName: string, bytes: Uint8Array): void => {
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], {
      type: "application/octet-stream",
    })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // The download reads the URL after the click returns, so it cannot be revoked at once.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
};
