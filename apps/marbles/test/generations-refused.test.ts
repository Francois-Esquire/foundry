import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileDigests,
  fingerprintOf,
  printNow,
  watching,
} from "~/process/fingerprint";
import {
  generationFiles,
  startSwitchingWorkspace,
} from "./helpers/generation-switch";
import { testHome } from "./helpers/home";

function prints(root: string, outside: readonly string[]) {
  const registration = { config: null, id: "w", root };
  return fingerprintOf(
    "installation",
    new Map([["w", printNow(registration, outside, new FileDigests())]])
  );
}

describe("refused candidates", () => {
  it("keeps a refused fingerprint as the candidate took it when no generation came before", () => {
    const home = testHome({ providers: false });
    const root = join(home.path, "project");
    mkdirSync(root);
    writeFileSync(join(root, "marbles.config.ts"), "export {};\n");
    const candidate = prints(root, []);
    expect(watching(candidate, undefined)).toBe(candidate);
  });

  it("keeps watching, in a refused fingerprint, a file the previous generation read outside the root that is missing", () => {
    const home = testHome({ providers: false });
    const root = join(home.path, "project");
    mkdirSync(root);
    writeFileSync(join(root, "marbles.config.ts"), "export {};\n");
    const helper = join(home.path, "helper.ts");
    const refused = watching(prints(root, []), prints(root, [helper]));
    expect(refused.sources.get("w")?.outside.get(helper)).toBe("missing");
    expect(
      prints(root, [...(refused.sources.get("w")?.outside.keys() ?? [])]).digest
    ).toBe(refused.digest);
    writeFileSync(helper, "export const value = 200;\n");
    expect(
      prints(root, [...(refused.sources.get("w")?.outside.keys() ?? [])]).digest
    ).not.toBe(refused.digest);
  });

  it("keeps what the candidate itself read outside the root over what the previous generation read", () => {
    const home = testHome({ providers: false });
    const root = join(home.path, "project");
    mkdirSync(root);
    writeFileSync(join(root, "marbles.config.ts"), "export {};\n");
    const helper = join(home.path, "helper.ts");
    const watched = prints(root, [helper]);
    writeFileSync(helper, "export const value = 1;\n");
    const candidate = prints(root, [helper]);
    expect(watching(candidate, watched).digest).toBe(candidate.digest);
  });

  it("switches once a helper outside the root, whose removal kept a candidate from loading, is back with other code", async () => {
    const home = testHome({ providers: false });
    const fixture = generationFiles(home);
    const shared = join(home.path, "shared");
    mkdirSync(shared);
    const helper = join(shared, "helper.ts");
    writeFileSync(helper, "export const value = 1;\n");
    const lines: string[] = [];
    const { client, summary } = await startSwitchingWorkspace(
      fixture,
      `import { value } from ${JSON.stringify(helper)};
import { step } from "@foundry.sh/marbles";
export const read = step("read").do(() => value);
`,
      { print: (line) => lines.push(line) }
    );
    const first = summary.pid ?? 0;
    const workspace = client.workspace(summary);
    expect((await workspace.roll("read")).value).toBe(1);

    rmSync(helper);
    await vi.waitFor(
      async () => {
        const [refusing] = await client.workspaces();
        expect(refusing?.error, lines.join("\n")).toBeDefined();
      },
      { interval: 200, timeout: 60_000 }
    );
    expect((await client.workspaces())[0]?.pid).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(
      lines.filter((line) => line.includes(" starting: ")),
      lines.join("\n")
    ).toHaveLength(2);

    writeFileSync(helper, "export const value = 200;\n");
    await vi.waitFor(
      async () => {
        const [repaired] = await client.workspaces();
        expect(repaired?.state, lines.join("\n")).toBe("ready");
        expect(repaired?.pid, lines.join("\n")).not.toBe(first);
      },
      { interval: 200, timeout: 60_000 }
    );
    expect((await workspace.roll("read")).value).toBe(200);
    client.close();
  }, 150_000);
});
