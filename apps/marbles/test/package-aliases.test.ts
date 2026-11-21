import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { step as publishedStep } from "@foundry.sh/marbles";
import { Engine as PublishedEngine } from "@foundry.sh/marbles/engine";
import { DatabaseProviderStore as PublishedProviderStore } from "@foundry.sh/marbles/lib";
import { codeReview as publishedCodeReview } from "@foundry.sh/marbles/prebuilt";
import { startDaemon as publishedStartDaemon } from "@foundry.sh/marbles/process";
import { EXECUTION_STATUSES as PUBLISHED_STATUSES } from "@foundry.sh/marbles/statuses";
import { createStarter as publishedCreateStarter } from "@foundry.sh/marbles/workspace";
import { describe, expect, it } from "vitest";

import { step } from "~/authoring/index";
import { codeReview } from "~/authoring/prebuilt";
import { Engine } from "~/entries/engine";
import { DatabaseProviderStore } from "~/entries/lib";
import { EXECUTION_STATUSES } from "~/lib/execution-statuses";
import { startDaemon } from "~/process/index";
import { createStarter } from "~/workspace/index";

const subpaths: [string, unknown, unknown][] = [
  [".", publishedStep, step],
  ["./engine", PublishedEngine, Engine],
  ["./lib", PublishedProviderStore, DatabaseProviderStore],
  ["./prebuilt", publishedCodeReview, codeReview],
  ["./process", publishedStartDaemon, startDaemon],
  ["./statuses", PUBLISHED_STATUSES, EXECUTION_STATUSES],
  ["./workspace", publishedCreateStarter, createStarter],
];

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")
) as { exports: Record<string, unknown> };

describe("package source aliases", () => {
  it("covers every published subpath", () => {
    expect(subpaths.map(([subpath]) => subpath).sort()).toEqual(
      Object.keys(manifest.exports).sort()
    );
  });

  it.each(subpaths)(
    "resolves %s to the entry it is built from",
    (_subpath, published, source) => {
      expect(published).toBe(source);
    }
  );
});
