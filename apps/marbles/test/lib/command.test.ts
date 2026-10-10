/**
 * Command steps and a body's `exec`: argument lists, never shell text,
 * wired to the step's directory, stream, signal, and dry run.
 */

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
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
  catalog.reset();
  await rm(root, { force: true, recursive: true });
});

async function start(dry = false) {
  engine = await startEngine({
    dry,
    print: (line) => lines.push(line),
    root,
  });
  return engine;
}

describe("command steps", () => {
  it("fills each placeholder into one argument and runs in the step's directory", async () => {
    step("greet")
      .input(z.object({ extra: z.array(z.string()), who: z.string() }))
      .exec("printf '%s|' $who $extra");
    step("where").exec("pwd");
    const host = await start();
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
    step("fails").exec("sh -c 'exit 3'");
    step("reports").exec("sh -c 'exit 3'", { check: false });
    const host = await start();
    await expect(host.run("fails", {})).rejects.toThrow(EXITED);
    await expect(host.run("reports", {})).resolves.toMatchObject({
      exitCode: 3,
    });
  });

  it("takes argv from a function", async () => {
    step("listed")
      .input(z.object({ words: z.array(z.string()) }))
      .exec(({ input }) => ["echo", ...input.words]);
    const host = await start();
    await expect(
      host.run("listed", { words: ["one", "two"] })
    ).resolves.toMatchObject({ stdout: "one two\n" });
  });

  it("prints instead of running under a dry run", async () => {
    step("install")
      .input(z.object({ pkg: z.string() }))
      .exec("npm i $pkg");
    const host = await start(true);
    await expect(host.run("install", { pkg: "left pad" })).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "",
    });
    expect(lines).toContain(`[exec] ${root}: npm i 'left pad'`);
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
    step("body").do(async ({ exec }) => {
      const { stdout } = await exec(["echo", "$HOME is not expanded"]);
      return stdout.trim();
    });
    const host = await start();
    await expect(host.run("body", {})).resolves.toBe("$HOME is not expanded");
  });
});
