import { writeFileSync } from "node:fs";
import { join, sep } from "node:path";

export function fakeClaude(dir: string): string {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.CLAUDE_CONFIG_DIR;
const catalog = home?.startsWith(${JSON.stringify(dir + sep)})
  ? join(home, "models.json")
  : undefined;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type !== "control_request" || request.request?.subtype !== "initialize") {
    if (catalog) writeFileSync(join(home, "unexpected-request"), request.type);
    process.exit(2);
  }
  const models = catalog && existsSync(catalog)
    ? JSON.parse(readFileSync(catalog, "utf8"))
    : [{ value: "opus" }, { value: "sonnet" }, { value: "haiku" }, { value: "fable" }];
  if (models === "hang") {
    writeFileSync(join(home, "listing.pid"), String(process.pid));
    continue;
  }
  const reply = models === null || process.env.ANTHROPIC_API_KEY === "ambient-test-key"
    ? { subtype: "error", error: "listing failed" }
    : { subtype: "success", response: { commands: [], models } };
  console.log(JSON.stringify({
    type: "control_response",
    response: { ...reply, request_id: request.request_id },
  }));
}
`,
    { mode: 0o755 }
  );
  return path;
}
