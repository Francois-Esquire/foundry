import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import type { CollectInput } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { startEngine } from "../helpers/engine";

const NOT_INPUT = /\$who is not an input key/;
const NOT_DECLARED = /\$who is not declared; add it to \.input\(\)/;
const PROGRAM = /the program, the first word, must be written out/;
const EXITED = /sh -c 'exit 3' exited with 3/;

let root: string;
let engine: Engine | undefined;
const lines: string[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "marbles-command-")));
});

afterEach(async () => {
  await engine?.stop();
  engine = undefined;
  lines.length = 0;
  await rm(root, { force: true, recursive: true });
});

async function start(collect: CollectInput) {
  engine = await startEngine({
    collect,
    print: (line) => lines.push(line),
    root,
  });
  return engine;
}

describe("command steps", () => {
  it("fills each placeholder into one argument and runs in the step's directory", async () => {
    const greet = step("greet")
      .input(z.object({ extra: z.array(z.string()), who: z.string() }))
      .exec("printf '%s|' $who $extra");
    const where = step("where").exec("pwd");
    const host = await start([greet, where]);
    await expect(
      host.run("greet", { extra: ["a b", "c"], who: "x; echo pwned" })
    ).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "x; echo pwned|a b|c|",
    });
    await expect(host.run("where", {})).resolves.toMatchObject({
      stdout: `${root}\n`,
    });
  });

  it("fails on a non-zero exit unless told not to check", async () => {
    const fails = step("fails").exec("sh -c 'exit 3'");
    const reports = step("reports").exec("sh -c 'exit 3'", { check: false });
    const host = await start([fails, reports]);
    await expect(host.run("fails", {})).rejects.toThrow(EXITED);
    await expect(host.run("reports", {})).resolves.toMatchObject({
      exitCode: 3,
    });
  });

  it("takes argv from a function", async () => {
    const listed = step("listed")
      .input(z.object({ words: z.array(z.string()) }))
      .exec(({ input }) => ["echo", ...input.words]);
    const host = await start([listed]);
    await expect(
      host.run("listed", { words: ["one", "two"] })
    ).resolves.toMatchObject({ stdout: "one two\n" });
  });

  it("checks the template when the module loads", () => {
    expect(() =>
      step("a")
        .input(z.object({ name: z.string() }))
        .exec("echo $who")
    ).toThrow(NOT_INPUT);
    expect(() => step("b").exec("echo $who")).toThrow(NOT_DECLARED);
    expect(() =>
      step("c")
        .input(z.object({ tool: z.string() }))
        .exec("$tool --version")
    ).toThrow(PROGRAM);
  });
});

describe("a body's exec", () => {
  it("runs a command from a body with the same rules", async () => {
    const body = step("body").do(async ({ exec }) => {
      const { stdout } = await exec(["echo", "$HOME is not expanded"]);
      return stdout.trim();
    });
    const host = await start([body]);
    await expect(host.run("body", {})).resolves.toBe("$HOME is not expanded");
  });
});
