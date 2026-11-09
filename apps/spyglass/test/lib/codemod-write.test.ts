import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256 } from "../../src/lib/apply";
import type { ApplyJournal } from "../../src/lib/apply-journal";
import { applyRecord } from "../../src/lib/codemod-apply";
import { spawnRunner } from "../../src/lib/operator-readiness";
import { scan } from "../../src/lib/scan";
import {
  afterTheWrite,
  outputFiles,
  pass,
  plannedCopy,
  READY,
  withoutVolatile,
} from "../helpers/codemod-fixture";
import { scanCacheSeeds } from "../helpers/scan-cache-seeds";

/** Every scanned copy after the first of its kind starts from that copy's cache. */
const seeds = scanCacheSeeds();
afterAll(seeds.dispose);

describe("applyRecord, writing", () => {
  const INDEX = "packages/plans/src/index.ts";
  const directories: string[] = [];
  const WRITE_TIMEOUT = 120_000;
  // Two cold history scans and an apply run exceed the ordinary write budget on CI.
  const HISTORY_WRITE_TIMEOUT = 240_000;

  afterAll(() => {
    for (const directory of directories) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  const planned = (options: { git?: boolean; history?: boolean } = {}) =>
    plannedCopy(seeds, directories, options);

  it(
    "journals before it writes, verifies, scans again, keeps history, and then deletes the record and the journal",
    async () => {
      const copy = await planned({ history: true });
      const historyManifest = join(
        copy.workspace.output,
        "history/manifest.json"
      );
      const savedHistory = readFileSync(historyManifest, "utf8");
      const before = JSON.parse(
        readFileSync(join(copy.workspace.output, "manifest.json"), "utf8")
      );
      const original = copy.read(INDEX);
      let journal: ApplyJournal | undefined;
      const runner = afterTheWrite((command, at) => {
        journal = JSON.parse(readFileSync(copy.journal, "utf8"));
        return pass(command, at);
      });
      const result = await copy.write({ runner });
      expect(result.status).toBe("applied");
      expect(result.scan).toMatchObject({
        output: copy.workspace.output,
        status: "published",
      });
      expect(result.verification?.status).toBe("pass");
      expect(result.verification?.checks.at(-1)).toEqual({
        check: "tests · @deps/plans",
        detail:
          "bun run test in packages/plans shows no failure it did not show before the write.",
        status: "pass",
      });
      expect(runner.runs).toBe(2);
      expect(journal).toEqual({
        files: [
          {
            file: INDEX,
            mode: statSync(join(copy.root, INDEX)).mode % 0o1_0000,
            original: original.toString("base64"),
            originalHash: sha256(original),
            writtenHash: sha256(copy.read(INDEX)),
          },
        ],
        phase: "writing",
        planId: copy.site.planId,
        schemaVersion: 1,
        site: READY,
        startedAt: expect.any(String),
      });
      expect(copy.read(INDEX).toString("utf8")).not.toContain("PlanAlpha");
      expect(copy.status().trim()).toBe(`M ${INDEX}`);
      expect(existsSync(copy.journal)).toBe(false);
      expect(existsSync(copy.record)).toBe(false);
      const after = JSON.parse(
        readFileSync(join(copy.workspace.output, "manifest.json"), "utf8")
      );
      expect(after.generatedAt > before.generatedAt).toBe(true);
      expect(readFileSync(historyManifest, "utf8")).toBe(savedHistory);
      expect(existsSync(`${copy.workspace.output}.next`)).toBe(false);

      // What apply published is what a later scan produces, from a cold
      // cache in a fresh state directory, so nothing is reused from apply's.
      const applied = outputFiles(copy.workspace.output);
      const fresh = await scan(copy.root, {
        history: true,
        state: join(copy.directory, "fresh-state"),
      });
      expect(fresh.manifest.generation.packagesReused).toBe(0);
      const rescanned = outputFiles(fresh.output);
      expect(Object.keys(rescanned).sort()).toEqual(
        Object.keys(applied).sort()
      );
      for (const [file, text] of Object.entries(applied)) {
        expect(withoutVolatile(file, rescanned[file]), file).toEqual(
          withoutVolatile(file, text)
        );
      }
      await expect(copy.write()).rejects.toThrow(
        `No authorized plan is saved for ${copy.site.opportunity}.`
      );
    },
    HISTORY_WRITE_TIMEOUT
  );

  it(
    "rolls back byte for byte when a script fails after the write where it passed before",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      const published = outputFiles(copy.workspace.output);
      const result = await copy.write({
        runner: afterTheWrite(() => ({
          exitCode: 1,
          output: " FAIL  src/plans.test.ts > plans\n",
        })),
      });
      expect(result.status).toBe("rolled-back");
      // The staged scan of the write is discarded, and the published dataset is as it was.
      expect(outputFiles(copy.workspace.output)).toEqual(published);
      expect(existsSync(`${copy.workspace.output}.next`)).toBe(false);
      expect(
        result.verification?.checks.filter((c) => c.status === "fail")
      ).toEqual([
        {
          check: "tests · @deps/plans",
          detail:
            "bun run test in packages/plans fails where it did not before the write: FAIL src/plans.test.ts > plans",
          status: "fail",
        },
      ]);
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(copy.status()).toBe("");
      expect(existsSync(copy.journal)).toBe(false);
      expect(existsSync(copy.record)).toBe(true);
    },
    WRITE_TIMEOUT
  );

  it(
    "fails the step, and rolls back, when a script is killed for running past its timeout",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      const result = await copy.write({
        runner: afterTheWrite((command, at) =>
          spawnRunner({ ...command, args: ["5"], executable: "sleep" }, at, {
            timeoutMs: 200,
          })
        ),
      });
      expect(result.status).toBe("rolled-back");
      expect(
        result.verification?.checks.filter((c) => c.status === "fail")
      ).toEqual([
        {
          check: "tests · @deps/plans",
          detail:
            "bun run test in packages/plans was killed by SIGTERM: it ran past its timeout (ETIMEDOUT).",
          status: "fail",
        },
      ]);
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "refuses before writing when a script fails under the lock, before the write",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      const result = await applyRecord(copy.root, copy.site, {
        runner: () => ({
          exitCode: 1,
          output: " FAIL  src/old.test.ts > known\n",
        }),
        state: copy.state,
        write: true,
      });
      expect(result.status).toBe("refused");
      expect(
        result.refusal?.kind === "readiness" &&
          result.refusal.readiness.authorization
      ).toBe("blocked");
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
    },
    WRITE_TIMEOUT
  );

  it(
    "restores every written file when a check throws, or a signal arrives",
    async () => {
      const copy = await planned();
      const original = copy.read(INDEX);
      await expect(
        copy.write({
          runner: afterTheWrite(() => {
            throw new Error("the test runner crashed");
          }),
        })
      ).rejects.toThrow("the test runner crashed");
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);

      const signals = new EventEmitter();
      await expect(
        copy.write({
          runner: afterTheWrite((command, at) => {
            signals.emit("SIGINT", "SIGINT");
            return pass(command, at);
          }),
          signals,
        })
      ).rejects.toThrow("Interrupted by SIGINT");
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(copy.status()).toBe("");
      expect(existsSync(copy.journal)).toBe(false);
      expect(signals.listenerCount("SIGINT")).toBe(0);

      // A signal whose listener runs only after the last check still undoes
      // the write, before it is marked verified.
      const late = new EventEmitter();
      await expect(
        copy.write({
          runner: afterTheWrite((command, at) => {
            setImmediate(() =>
              setImmediate(() => late.emit("SIGTERM", "SIGTERM"))
            );
            return pass(command, at);
          }),
          signals: late,
        })
      ).rejects.toThrow("Interrupted by SIGTERM");
      expect(copy.read(INDEX).equals(original)).toBe(true);
      expect(existsSync(copy.journal)).toBe(false);
      expect(existsSync(copy.record)).toBe(true);
    },
    WRITE_TIMEOUT
  );
});
