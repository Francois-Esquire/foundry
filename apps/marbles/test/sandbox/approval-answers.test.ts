import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHarnessPermission } from "@foundry/agents/harness";
import { Sessions } from "@foundry/agents/session";
import { Authorization } from "@foundry/authorization";
import { SqliteAuthorizationStore } from "@foundry/authorization/store/sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { DatabaseSessionStore } from "~/database/sessions";
import { HarnessInteractions } from "~/lib/sandbox/interactions";
import { recordSpawned } from "~/process/spawned";
import { openFeed } from "../helpers/feed";

const SRC = resolve("src");
const source = { definition: "test", path: [], runId: "run" };
const profile = {
  allowedTools: [],
  disallowedTools: [],
  maxSteps: 2,
  mode: "scheduled" as const,
  unresolved: "ask" as const,
};
const call = {
  input: { command: "echo hi" },
  sessionId: "session",
  signal: new AbortController().signal,
  toolCallId: "call",
  toolName: "bash",
};

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

function host(dir: string, file: string, name: string, choice: string) {
  const at = (module: string) => JSON.stringify(join(SRC, module));
  return `
import { existsSync, writeFileSync } from "node:fs";
import { Authorization } from "@foundry/authorization";
import { SqliteAuthorizationStore } from "@foundry/authorization/store/sqlite";
import { openDatabase } from ${at("database/open.ts")};
import { DatabaseSessionStore } from ${at("database/sessions.ts")};
import { HarnessInteractions } from ${at("lib/sandbox/interactions.ts")};
const opened = await openDatabase(${JSON.stringify(file)});
const kept = { database: opened.database, scope: "ws" };
const authorization = new Authorization({ store: new SqliteAuthorizationStore(kept) });
let question;
const feed = { publishInput: async (asked) => { question ??= asked.key; return asked.key; } };
const interactions = new HarnessInteractions({ askable: true, authorization, feed, sessions: new DatabaseSessionStore(kept) });
await interactions.restore();
writeFileSync(${JSON.stringify(dir)} + "/ready-" + ${JSON.stringify(name)}, "");
while (!existsSync(${JSON.stringify(join(dir, "go"))})) {
  await new Promise((settle) => setTimeout(settle, 5));
}
const outcome = await interactions.answer(question, ${JSON.stringify(choice)}).then(
  () => ({ answered: true }),
  (error) => ({ refused: String(error) })
);
await interactions.close();
opened.close();
process.stdout.write(JSON.stringify(outcome));
`;
}

function run(script: string): Promise<Record<string, unknown>> {
  return new Promise((settle, fail) => {
    const child = spawn("bun", ["--eval", script], {
      cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    recordSpawned(child.pid, false);
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once("exit", (code) => {
      if (code === 0) {
        settle(JSON.parse(out) as Record<string, unknown>);
      } else {
        fail(new Error(`a host exited ${String(code)}: ${err}`));
      }
    });
  });
}

it("lets one of two hosts answering the same deferred approval at once win, and the other grant nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marbles-answers-"));
  dirs.push(dir);
  const file = join(dir, "marbles.db");
  const opened = await initializeDatabase(file);
  const kept = { database: opened.database, scope: "ws" };
  const sessions = new DatabaseSessionStore(kept);
  const auth = () =>
    new Authorization({ store: new SqliteAuthorizationStore(kept) });
  try {
    const bridge = new HarnessInteractions({
      askable: true,
      authorization: auth(),
      feed: openFeed(undefined, { id: "ws", root: dir }).publisher,
      sessions,
    });
    await new Sessions({ store: sessions }).createSession({ id: "session" });
    await createHarnessPermission({
      agentId: "coder",
      profile,
      store: sessions,
      ...bridge.authority(source),
    })(call);
    await bridge.close();

    const hosts = [
      run(host(dir, file, "a", "Allow future runs")),
      run(host(dir, file, "b", "Deny")),
    ];
    await new Promise((settle) => setTimeout(settle, 1500));
    await writeFile(join(dir, "go"), "");
    const [allow, deny] = await Promise.all(hosts);

    const outcomes = [allow, deny];
    expect(outcomes.filter((outcome) => outcome?.answered)).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome?.refused !== undefined)?.refused
    ).toContain("already has a response");
    const responses = (await sessions.listMessages("session"))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool_approval_response");
    expect(responses).toHaveLength(1);
    await new Sessions({ store: sessions }).createSession({ id: "future" });
    const later = await createHarnessPermission({
      agentId: "coder",
      authorization: auth(),
      profile,
      store: sessions,
    })({ ...call, sessionId: "future", toolCallId: "future" });
    expect(later.behavior).toBe(allow?.answered ? "allow" : "deny");
  } finally {
    opened.close();
  }
}, 30_000);
