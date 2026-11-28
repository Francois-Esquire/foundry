import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHolder } from "@foundry/lib/node/file-lock";
import { expect, onTestFinished } from "vitest";
import { Artifacts } from "../../artifacts";
import type { BlobFiles } from "../../blob-staging";
import { CHUNK_BYTES } from "../../blob-staging";
import { blobFiles, JsonArtifactStore } from "../../node";
import type { ArtifactStore } from "../../store";
import { openStore, type StoreKind } from "./stores";

export const text = (value: string) => new TextEncoder().encode(value);
export const decoded = (bytes: Uint8Array | undefined) =>
  new TextDecoder().decode(bytes);
export const chunk = (fill: number) => new Uint8Array(CHUNK_BYTES).fill(fill);
export function gated(
  before: readonly Uint8Array[],
  after: readonly Uint8Array[]
) {
  const waiting = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  async function* source(): AsyncIterable<Uint8Array> {
    yield* before;
    waiting.resolve();
    await released.promise;
    yield* after;
  }
  return {
    release: () => released.resolve(),
    source: source(),
    waiting: waiting.promise,
  };
}
export async function within(
  promise: Promise<unknown>,
  ms = 1000
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        () => "rejected"
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function stagedFiles(blobs: string): Promise<string[]> {
  const root = join(blobs, ".staging");
  const found: string[] = [];
  for (const owner of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, owner)).catch(() => [])) {
      found.push(join(owner, name));
    }
  }
  return found;
}
export async function publishedFiles(blobs: string): Promise<string[]> {
  return (await readdir(blobs).catch(() => []))
    .filter((name) => !name.startsWith("."))
    .sort();
}
export async function referencedFiles(store: ArtifactStore): Promise<string[]> {
  return (await store.listBlobs())
    .flatMap((blob) => (blob.path ? [blob.path] : []))
    .sort();
}
export async function storage(kind: StoreKind) {
  const root = await mkdtemp(join(tmpdir(), "artifact-staging-"));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  const blobs = join(root, "blobs");
  const records = join(root, "records.json");
  const shared = kind === "json" ? undefined : await openStore(kind);
  const open = (): ArtifactStore =>
    shared ?? new JsonArtifactStore({ path: records });
  const store = open();
  const openArtifacts = (
    options: {
      readonly files?: BlobFiles | null;
      readonly maxFileBytes?: number;
      readonly maxTreeBytes?: number;
      readonly store?: ArtifactStore;
    } = {}
  ) =>
    new Artifacts({
      ...(options.files === null
        ? {}
        : { files: options.files ?? blobFiles(blobs) }),
      store: options.store ?? open(),
      ...(options.maxFileBytes === undefined
        ? {}
        : { maxFileBytes: options.maxFileBytes }),
      ...(options.maxTreeBytes === undefined
        ? {}
        : { maxTreeBytes: options.maxTreeBytes }),
    });
  const settled = async () => {
    expect(await stagedFiles(blobs)).toEqual([]);
    expect(await publishedFiles(blobs)).toEqual(await referencedFiles(store));
  };
  const lockHeld = () =>
    kind === "json" && lockHolder(`${records}.lock`) !== undefined;
  return { blobs, lockHeld, open, openArtifacts, settled, store };
}
