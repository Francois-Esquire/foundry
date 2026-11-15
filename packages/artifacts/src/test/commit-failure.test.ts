import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactManager } from "../manager";
import { blobFiles, JsonArtifactStore } from "../node";
import { artifactIdSchema } from "../ref";
import type { ArtifactStore } from "../store";
import { InMemoryArtifactStore } from "../store/memory";
import type { CommitInterceptor } from "../testing";
import { interceptCommits } from "../testing";
import { required } from "./helpers/required";

/** A published blob file, not a temporary beside one. */
const PUBLISHED_BLOB = /^[a-f0-9-]+$/;

/** How the next records-file replacement fails, if it does. */
const recordsFile: {
  failure?: "before rename" | "after rename" | "stat after rename";
  statFails?: boolean;
} = {};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (recordsFile.statFails && String(args[0]).endsWith("records.json")) {
        recordsFile.statFails = false;
        return Promise.reject(
          Object.assign(new Error("EIO: stat failed"), { code: "EIO" })
        );
      }
      return actual.stat(...args);
    },
  };
});

vi.mock("@foundry/lib/atomic-file", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@foundry/lib/atomic-file")>();
  return {
    ...actual,
    writeFileAtomic: async (
      ...args: Parameters<typeof actual.writeFileAtomic>
    ) => {
      const [path] = args;
      const failure = path.endsWith("records.json")
        ? recordsFile.failure
        : undefined;
      if (failure === "before rename") {
        throw Object.assign(new Error("EIO: write failed"), { code: "EIO" });
      }
      await actual.writeFileAtomic(...args);
      if (failure === "stat after rename") {
        recordsFile.statFails = true;
      }
      if (failure === "after rename") {
        // The directory sync after the rename fails: the file is replaced.
        throw Object.assign(new Error("EIO: directory sync failed"), {
          code: "EIO",
        });
      }
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  recordsFile.failure = undefined;
  recordsFile.statFails = false;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function harness(open: (root: string) => ArtifactStore) {
  const root = await mkdtemp(join(tmpdir(), "artifact-commit-failure-"));
  roots.push(root);
  const blobs = join(root, "blobs");
  const artifacts = new ArtifactManager({
    files: blobFiles(blobs),
    store: open(root),
  });
  const id = artifactIdSchema.parse(crypto.randomUUID());
  const create = () =>
    artifacts.create({
      entries: { "entry.md": { bytes: "# Kept" } },
      id,
      metadata: { entry: "entry.md" },
      name: "Notes",
      type: "text/markdown",
    });
  const files = async () =>
    (await readdir(blobs).catch(() => [])).filter((name) =>
      PUBLISHED_BLOB.test(name)
    );
  return { artifacts, create, files, id };
}

const refuse: CommitInterceptor = () =>
  Promise.reject(new Error("commit refused"));
/** A memory store whose first transaction fails once its commits landed. */
class FailsAfterLanding extends InMemoryArtifactStore {
  #failed: boolean;

  constructor() {
    super();
    this.#failed = false;
  }

  override async transaction<T>(
    work: (view: ArtifactStore) => Promise<T>
  ): Promise<T> {
    const result = await super.transaction(work);
    if (this.#failed) {
      return result;
    }
    this.#failed = true;
    throw new Error("failed after landing");
  }
}

describe("A commit that fails", () => {
  it("before its write lands removes the files it published", async () => {
    const { artifacts, create, files, id } = await harness(() =>
      interceptCommits(new InMemoryArtifactStore(), refuse)
    );
    await expect(create()).rejects.toThrow("commit refused");
    expect(await artifacts.get(id)).toBeNull();
    expect(await files()).toEqual([]);
  });

  it("after its write landed keeps the files its records name", async () => {
    const { artifacts, create, files, id } = await harness(
      () => new FailsAfterLanding()
    );
    await expect(create()).rejects.toThrow("failed after landing");
    const artifact = await artifacts.get(id);
    expect(await files()).toHaveLength(1);
    const entry = await artifacts.readRoot(required(artifact?.contentId));
    expect(new TextDecoder().decode(entry?.blob)).toBe("# Kept");
  });

  it("in the JSON store before the rename removes the files it published", async () => {
    const { artifacts, create, files, id } = await harness(
      (root) => new JsonArtifactStore({ path: join(root, "records.json") })
    );
    recordsFile.failure = "before rename";
    await expect(create()).rejects.toThrow("write failed");
    recordsFile.failure = undefined;
    expect(await artifacts.get(id)).toBeNull();
    expect(await files()).toEqual([]);
  });

  it("in the JSON store after the rename keeps the files the records name", async () => {
    const { artifacts, create, files, id } = await harness(
      (root) => new JsonArtifactStore({ path: join(root, "records.json") })
    );
    recordsFile.failure = "after rename";
    await expect(create()).rejects.toThrow("directory sync failed");
    recordsFile.failure = undefined;
    const artifact = await artifacts.get(id);
    expect(artifact?.name).toBe("Notes");
    expect(await files()).toHaveLength(1);
    const entry = await artifacts.readRoot(required(artifact?.contentId));
    expect(new TextDecoder().decode(entry?.blob)).toBe("# Kept");
  });

  it("never fails a JSON commit whose follow-up stat fails after the rename", async () => {
    const { artifacts, create, files, id } = await harness(
      (root) => new JsonArtifactStore({ path: join(root, "records.json") })
    );
    recordsFile.failure = "stat after rename";
    await create();
    recordsFile.failure = undefined;
    expect(recordsFile.statFails).toBe(false);
    const artifact = await artifacts.get(id);
    expect(artifact?.name).toBe("Notes");
    expect(await files()).toHaveLength(1);
  });
});
