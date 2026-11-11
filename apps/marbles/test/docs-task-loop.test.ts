import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "vitest";

it("records intake once through the documented observer in a hosted workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-doc-loop-"));
  const script = join(root, "test.ts");
  const source = resolve(
    "../documentation/marbles/get-started/_example/task-loop.ts"
  );
  try {
    await writeFile(
      script,
      `import { hostEngine, openWorkspace } from ${JSON.stringify(resolve("src/workspace/open.ts"))};
import { tasks } from ${JSON.stringify(resolve("src/authoring/tasks.ts"))};
const args = { artifacts: ${JSON.stringify(join(root, "artifacts"))}, config: ${JSON.stringify(source)}, dry: false, only: [], state: ${JSON.stringify(join(root, "state"))} };
const opened = await openWorkspace(args, { print: () => undefined });
const engine = await hostEngine(args, opened, { print: () => undefined });
await engine.start();
const task = await tasks.create({ title: "Review", tags: ["intake"], metadata: { kept: "yes" } });
const deadline = Date.now() + 10000;
let current;
do {
  current = await tasks.get(task.id);
  if (current?.metadata.intakeRecorded === true) break;
  await Bun.sleep(20);
} while (Date.now() < deadline);
if (current?.metadata.intakeRecorded !== true || current.metadata.kept !== "yes") throw new Error("Intake was not recorded");
const markedAt = current.updatedAt;
await Bun.sleep(200);
current = await tasks.get(task.id);
if (current.updatedAt !== markedAt) throw new Error("Observer wrote repeatedly");
await engine.dispose();
`
    );
    execFileSync("bun", [script], { cwd: resolve("."), timeout: 30_000 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 40_000);
