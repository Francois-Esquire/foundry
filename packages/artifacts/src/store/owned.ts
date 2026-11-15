import { ownedWrite as withOwnedEvents } from "@foundry/lib/plain-json";

import type { ArtifactRecords, Blob } from "../schema";
import type { ArtifactStoreWrite } from "./index";

/**
 * A store's own copy of `write`, taken now: a `structuredClone` of the
 * whole write, then each blob's inline bytes copied again into a fresh
 * buffer of their own. `structuredClone` keeps a `SharedArrayBuffer`'s
 * memory shared (as Node does), so without that second copy a caller
 * changing the bytes after `commit`, or a reader changing bytes a store
 * handed out, would change what the store holds. Inline bytes are the one
 * place the record schema admits a byte buffer; metadata is plain JSON.
 *
 * Throws what the clone throws, for a write holding a value it refuses, and
 * a `TypeError` for events that are not plain JSON (`ownedEvents` in
 * `@foundry/lib/plain-json`).
 */
export function ownedWrite(write: ArtifactStoreWrite): ArtifactStoreWrite {
  // Events are taken first, as the plain JSON a host is handed, since the
  // clone would turn a class instance into a plain object.
  const copy = withOwnedEvents(write);
  return copy.putBlobs === undefined
    ? copy
    : { ...copy, putBlobs: copy.putBlobs.map(ownedBlob) };
}

/** {@link ownedWrite} for a store's starting records. */
export function ownedRecords(records: ArtifactRecords): ArtifactRecords {
  const copy = structuredClone(records);
  return { ...copy, blobs: copy.blobs.map(ownedBlob) };
}

/** `blob` with its inline bytes, if any, in memory no one else holds. */
function ownedBlob(blob: Blob): Blob {
  return blob.bytes === undefined
    ? blob
    : { ...blob, bytes: new Uint8Array(blob.bytes) };
}
