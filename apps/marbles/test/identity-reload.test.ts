import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const SRC = resolve("src");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

it("names a definition from its export as it is now when the same process loads that workspace again after an edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-identity-reload-"));
  roots.push(root);
  const dir = join(root, "ws");
  await mkdir(dir, { recursive: true });
  const source = join(dir, "marbles.ts");
  const declare = (name: string) =>
    `import { step } from "@foundry.sh/marbles";\nexport const ${name} = step().do(() => 1);\n`;
  await writeFile(source, declare("alpha"));
  const script = join(root, "host.ts");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs";
import { openWorkspace } from ${JSON.stringify(join(SRC, "workspace/open.ts"))};
const args = { artifacts: ${JSON.stringify(join(root, "artifacts"))}, config: ${JSON.stringify(source)}, state: ${JSON.stringify(join(root, "state"))} };
const names = async () => [...(await openWorkspace(args, { print: () => undefined })).catalog.definitions.keys()];
const first = await names();
writeFileSync(${JSON.stringify(source)}, ${JSON.stringify(declare("gamma"))});
const second = await names();
process.stdout.write(JSON.stringify({ first, second }) + "\\n");
process.exit(0);
`
  );
  const output = execFileSync(process.execPath, [script], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(JSON.parse(output.trim().split("\n").at(-1) ?? "{}")).toEqual({
    first: ["alpha"],
    second: ["gamma"],
  });
}, 120_000);
