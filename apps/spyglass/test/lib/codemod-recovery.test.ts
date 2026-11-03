import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256 } from "../../src/lib/apply";
import { writeJournal } from "../../src/lib/apply-journal";
import { check } from "../../src/lib/check";
import { planSite, resolveSite } from "../../src/lib/codemod";
import { applyRecord } from "../../src/lib/codemod-apply";
import { scan } from "../../src/lib/scan";
import {
  ALSO_READY,
  journalFor,
  pass,
  plannedCopy,
  READY,
  refuse,
} from "../helpers/codemod-fixture";
import { scanCacheSeeds } from "../helpers/scan-cache-seeds";

/** Every scanned copy after the first of its kind starts from that copy's cache. */
const seeds = scanCacheSeeds();
afterAll(seeds.dispose);

describe("applyRecord, recovering", () => {
  const INDEX = "packages/plans/src/index.ts";
  const directories: string[] = [];
  const WRITE_TIMEOUT = 120_000;

  afterAll(() => {
    for (const directory of directories) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  const planned = (options: { git?: boolean; history?: boolean } = {}) =>
    plannedCopy(seeds, directories, options);

  it(
    "restores an interrupted write on the next apply, and plan, check, and scan refuse it until then",
    async () => {
      const copy = await planned();
      const path = join(copy.root, INDEX);
      const original = copy.read(INDEX);
      const half = Buffer.from(
        original
          .toString("utf8")
          .replace("export type { PlanAlpha }", "type { PlanAlpha }")
      );
      writeFileSync(path, half);
      await writeJournal(
        copy.workspace,
        journalFor(READY, "writing", [
          {
            file: INDEX,
            mode: 0o644,
            original: original.toString("base64"),
            originalHash: sha256(original),
            writtenHash: sha256(half),
          },
        ])
      );
      const interrupted = "was interrupted while it wrote the sources";
      await expect(
        planSite(copy.root, copy.site, { runner: pass, state: copy.state })
      ).rejects.toThrow(interrupted);
      await expect(check(copy.root, { state: copy.state })).rejects.toThrow(
        interrupted
      );
      await expect(
        scan.workspace(copy.root, { state: copy.state })
      ).rejects.toThrow(interrupted);
      const result = await applyRecord(copy.root, resolveSite(ALSO_READY), {
        runner: refuse,
        state: copy.state,
      });
      expect(result.refusal).toEqual({
        kind: "pending-write",
        phase: "writing",
        restored: [INDEX],
        site: READY,
        skipped: [],
      });
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "keeps the journal, and the file, when the file changed since the interrupted write",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      writeFileSync(join(copy.root, INDEX), "// someone else's edit\n");
      await writeJournal(
        copy.workspace,
        journalFor(READY, "writing", [
          {
            file: INDEX,
            mode: 0o644,
            original: original.toString("base64"),
            originalHash: sha256(original),
            writtenHash: sha256(Buffer.from("what Spyglass wrote")),
          },
        ])
      );
      await expect(copy.write()).rejects.toThrow(
        `Spyglass did not restore every file it wrote: ${INDEX} changed after Spyglass wrote it, so restoring it would overwrite that change. Restore ${INDEX} from Git. The journal, ${copy.journal}, keeps every original: restore each file it names from Git (its HEAD content) and the next spyglass apply finishes the restore, or delete the journal to keep the files as they are.`
      );
      expect(copy.read(INDEX).toString("utf8")).toBe(
        "// someone else's edit\n"
      );
      expect(existsSync(copy.journal)).toBe(true);
      // Restored from Git, the file holds its original, which the next apply skips.
      writeFileSync(join(copy.root, INDEX), original);
      expect((await copy.write()).refusal).toEqual({
        kind: "pending-write",
        phase: "writing",
        restored: [],
        site: READY,
        skipped: [INDEX],
      });
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "refuses a journal whose copy of a file is damaged",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      await writeJournal(
        copy.workspace,
        journalFor(READY, "writing", [
          {
            file: INDEX,
            mode: 0o644,
            original: Buffer.from("not the original").toString("base64"),
            originalHash: sha256(original),
            writtenHash: sha256(original),
          },
        ])
      );
      await expect(copy.write()).rejects.toThrow(
        `The journal, ${copy.journal}, holds a damaged copy of ${INDEX}`
      );
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(true);
    },
    WRITE_TIMEOUT
  );

  it(
    "keeps a verified write whose scan failed, and the next scan finishes it",
    async () => {
      const copy = await planned();
      const result = await copy.write({
        publish: () => Promise.reject(new Error("the scan crashed")),
      });
      expect(result.status).toBe("applied");
      expect(result.scan).toMatchObject({
        error: "the scan crashed",
        status: "failed",
      });
      expect(copy.read(INDEX).toString("utf8")).not.toContain("PlanAlpha");
      expect(JSON.parse(readFileSync(copy.journal, "utf8")).phase).toBe(
        "verified"
      );
      expect(existsSync(copy.record)).toBe(true);
      expect((await copy.write()).refusal).toMatchObject({
        kind: "pending-write",
        phase: "verified",
      });
      await scan.workspace(copy.root, { state: copy.state });
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "refuses to write outside a Git repository, though it previews",
    async () => {
      const copy = await planned({ git: false });
      const original = copy.read(INDEX);
      expect(
        (
          await applyRecord(copy.root, copy.site, {
            runner: pass,
            state: copy.state,
          })
        ).status
      ).toBe("preview");
      const result = await copy.write();
      expect(result.refusal).toEqual({
        kind: "no-git",
        reason:
          "The workspace is not in a Git repository, so Spyglass cannot tell whether a planned file has uncommitted changes. Write only in a repository.",
      });
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );
});
