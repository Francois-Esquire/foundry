import type { ArtifactRecords, Blob } from "../schema";
import type { ArtifactStoreWrite } from "./index";

export function ownedWrite(write: ArtifactStoreWrite): ArtifactStoreWrite {
  const copy = structuredClone(write);
  return copy.putBlobs === undefined
    ? copy
    : { ...copy, putBlobs: copy.putBlobs.map(ownedBlob) };
}

export function ownedRecords(records: ArtifactRecords): ArtifactRecords {
  const copy = structuredClone(records);
  return { ...copy, blobs: copy.blobs.map(ownedBlob) };
}

function ownedBlob(blob: Blob): Blob {
  return blob.bytes === undefined
    ? blob
    : { ...blob, bytes: new Uint8Array(blob.bytes) };
}
