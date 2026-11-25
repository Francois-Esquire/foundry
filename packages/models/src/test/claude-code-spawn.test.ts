import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { thisProcess } from "@foundry/lib/node/process-identity";
import { SPAWN_RECOVERY_ENV } from "@foundry/lib/node/spawn-record";
import { afterEach, expect, it, vi } from "vitest";
import { claudeCodeProvider } from "../claude-code";
import { codexProvider } from "../codex";
import { silentExecutable } from "./helpers/env-dump";

const CALL = {
  prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
} as LanguageModelV4CallOptions;
const made: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "models-cli-spawn-"));
  made.push(dir);
  return dir;
}

it("records the CLI a call starts, forgets it once it exits, and keeps its stderr in the call's error", async () => {
  const dir = scratch();
  const records = join(dir, "spawned");
  const go = join(dir, "go");
  const bin = join(dir, "cli");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const wait = () => fs.existsSync(${JSON.stringify(go)}) ? finish() : setTimeout(wait, 20);
const finish = () => { process.stderr.write("the CLI could not sign in\\n"); process.exit(1); };
wait();
`
  );
  chmodSync(bin, 0o755);
  vi.stubEnv(SPAWN_RECOVERY_ENV, records);
  const provider = claudeCodeProvider({
    config: { defaultSettings: { pathToClaudeCodeExecutable: bin } },
    env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
  });
  const call = Promise.resolve(
    provider.languageModel("sonnet").doGenerate(CALL)
  );
  call.catch(() => undefined);

  let names: string[] = [];
  for (let i = 0; i < 500 && names.length === 0; i += 1) {
    names = existsSync(records)
      ? readdirSync(records).filter((name) => name.endsWith(".json"))
      : [];
    await new Promise((done) => setTimeout(done, 20));
  }
  expect(names).toHaveLength(1);
  const record = JSON.parse(
    readFileSync(join(records, names[0] ?? ""), "utf8")
  );
  expect(record.owner).toEqual(thisProcess());
  expect(record.group).toBe(true);

  writeFileSync(go, "");
  await expect(call).rejects.toThrow(
    "stderr (tail): the CLI could not sign in"
  );
  expect(readdirSync(records).filter((name) => name.endsWith(".json"))).toEqual(
    []
  );
}, 30_000);

it("records the Codex app-server a call starts, once, and forgets it once it exits", async () => {
  const dir = scratch();
  const records = join(dir, "spawned");
  const cli = silentExecutable();
  made.push(dirname(cli.bin));
  vi.stubEnv(SPAWN_RECOVERY_ENV, records);
  const provider = codexProvider({
    config: { available: true, binPath: cli.bin },
    env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
  });
  const model = provider.languageModel("gpt-5.5");
  const call = Promise.resolve(model.doGenerate(CALL));
  call.catch(() => undefined);
  let names: string[] = [];
  for (let i = 0; i < 500 && names.length === 0; i += 1) {
    names = existsSync(records)
      ? readdirSync(records).filter((name) => name.endsWith(".json"))
      : [];
    await new Promise((done) => setTimeout(done, 20));
  }
  for (let i = 0; i < 500 && cli.pids().length === 0; i += 1) {
    await new Promise((done) => setTimeout(done, 20));
  }
  expect(names).toEqual([`${String(cli.pids()[0])}.json`]);
  await provider.dispose?.();
  await call.catch(() => undefined);
  expect(readdirSync(records).filter((name) => name.endsWith(".json"))).toEqual(
    []
  );
}, 30_000);
