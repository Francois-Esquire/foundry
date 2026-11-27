import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { step as publishedStep } from "@foundry.sh/marbles";
import { Engine as PublishedEngine } from "@foundry.sh/marbles/engine";
import { DatabaseProviderStore as PublishedProviderStore } from "@foundry.sh/marbles/lib";
import { startDaemon as publishedStartDaemon } from "@foundry.sh/marbles/process";
import { defineProvider as publishedDefineProvider } from "@foundry.sh/marbles/providers";
import { claudeCode as publishedClaudeCode } from "@foundry.sh/marbles/providers/claude-code";
import { codex as publishedCodex } from "@foundry.sh/marbles/providers/codex";
import { gateway as publishedGateway } from "@foundry.sh/marbles/providers/gateway";
import { pi as publishedPi } from "@foundry.sh/marbles/providers/pi";
import { vercel as publishedVercel } from "@foundry.sh/marbles/providers/vercel";
import { EXECUTION_STATUSES as PUBLISHED_STATUSES } from "@foundry.sh/marbles/statuses";
import { createStarter as publishedCreateStarter } from "@foundry.sh/marbles/workspace";
import { describe, expect, it } from "vitest";

import { step } from "~/authoring/index";
import { defineProvider } from "~/authoring/providers";
import { Engine } from "~/entries/engine";
import { DatabaseProviderStore } from "~/entries/lib";
import { EXECUTION_STATUSES } from "~/lib/execution-statuses";
import { claudeCode } from "~/lib/providers/claude-code";
import { codex } from "~/lib/providers/codex";
import { gateway } from "~/lib/providers/gateway";
import { pi } from "~/lib/providers/pi";
import { vercel } from "~/lib/providers/vercel";
import { startDaemon } from "~/process/index";
import { createStarter } from "~/workspace/index";

const subpaths: [string, unknown, unknown][] = [
  [".", publishedStep, step],
  ["./engine", PublishedEngine, Engine],
  ["./lib", PublishedProviderStore, DatabaseProviderStore],
  ["./process", publishedStartDaemon, startDaemon],
  ["./providers", publishedDefineProvider, defineProvider],
  ["./providers/claude-code", publishedClaudeCode, claudeCode],
  ["./providers/codex", publishedCodex, codex],
  ["./providers/gateway", publishedGateway, gateway],
  ["./providers/pi", publishedPi, pi],
  ["./providers/vercel", publishedVercel, vercel],
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
