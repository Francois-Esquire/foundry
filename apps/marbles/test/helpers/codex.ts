import { writeFileSync } from "node:fs";
import { join, sep } from "node:path";

export function fakeCodex(dir: string): string {
  const path = join(dir, "codex");
  writeFileSync(
    path,
    `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.CODEX_HOME;
const catalog = home?.startsWith(${JSON.stringify(dir + sep)})
  ? join(home, "models.json")
  : undefined;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: { userAgent: "codex/0.144.6" } }));
  } else if (method === "model/list") {
    const data = catalog && existsSync(catalog)
      ? JSON.parse(readFileSync(catalog, "utf8"))
      : [{ id: "gpt-5.5", isDefault: true }];
    if (data === "hang") {
      writeFileSync(join(home, "listing.pid"), String(process.pid));
      continue;
    }
    console.log(JSON.stringify(data === null
      ? { id, error: { code: -32603, message: "listing failed" } }
      : { id, result: { data, nextCursor: null } }));
  } else {
    console.log(JSON.stringify({ id, error: { code: -32601, message: "unexpected request" } }));
  }
}
`,
    { mode: 0o755 }
  );
  return path;
}
