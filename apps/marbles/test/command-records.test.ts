import { readdirSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { testEngine } from "./helpers/engine";
import { temporaryDirectory } from "./helpers/temporary";

afterEach(() => {
  catalog.reset();
  vi.unstubAllEnvs();
});

it("records a command a step runs in the spawned directory the engine was given", async () => {
  const spawned = temporaryDirectory("marbles-spawned-");
  step("listing").do(async ({ exec }) => {
    const { stdout } = await exec([
      "sh",
      "-c",
      'for i in $(seq 100); do [ -e "$0/$$.json" ] && break; sleep 0.05; done; ls "$0"; printf "%s" "$$"',
      spawned,
    ]);
    return stdout;
  });
  const engine = testEngine({ print: () => undefined, spawned });
  await engine.start();
  try {
    const listed = String(await engine.run("listing", {})).split("\n");
    const pid = listed.at(-1);
    expect(listed.slice(0, -1)).toEqual([`${String(pid)}.json`]);
    await vi.waitFor(() => expect(readdirSync(spawned)).toEqual([]));
  } finally {
    await engine.dispose();
  }
});
