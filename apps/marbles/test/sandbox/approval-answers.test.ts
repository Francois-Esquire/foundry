import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentAuthorizer } from "@foundry/agents/authorization";
import { createHarnessPermission } from "@foundry/agents/harness";
import { Sessions } from "@foundry/agents/session";
import { afterEach, expect, it } from "vitest";
import { DatabaseDeferredApprovalStore } from "~/database/approvals";
import { DatabaseGrantStorage } from "~/database/grants";
import { initializeDatabase } from "~/database/open";
import { DatabaseSessionStore } from "~/database/sessions";
import { StoredAgentGrantRepository } from "~/lib/sandbox/grants";
import { HarnessInteractions } from "~/lib/sandbox/interactions";
import { recordSpawned } from "~/process/spawned";
import { openFeed } from "../helpers/feed";

/**
 * Two hosts restored from one Marbles database answer the same deferred
 * approval at once, one Allow and one Deny. Each waits inside its grant
 * policy, up to a deadline, for the other to get there too: where the
 * unanswered check and the stored answer are separate steps, both pass
 * the check and both answers are kept.
 */

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
import { createAgentAuthorizer } from "@foundry/agents/authorization";
import { DatabaseDeferredApprovalStore } from ${at("database/approvals.ts")};
import { DatabaseGrantStorage } from ${at("database/grants.ts")};
import { openDatabase } from ${at("database/open.ts")};
import { DatabaseSessionStore } from ${at("database/sessions.ts")};
import { StoredAgentGrantRepository } from ${at("lib/sandbox/grants.ts")};
import { HarnessInteractions } from ${at("lib/sandbox/interactions.ts")};
const opened = await openDatabase(${JSON.stringify(file)});
const kept = { database: opened.database, scope: "ws" };
const base = createAgentAuthorizer({ grants: new StoredAgentGrantRepository(new DatabaseGrantStorage(kept)) });
const arrived = (who) => ${JSON.stringify(dir)} + "/arrived-" + who;
const policy = new Proxy(base, {
  get(target, key) {
    if (key === "resolveApproval") {
      return async (...args) => {
        writeFileSync(arrived(${JSON.stringify(name)}), "");
        const deadline = Date.now() + 1500;
        while (!existsSync(arrived(${JSON.stringify(name === "a" ? "b" : "a")})) && Date.now() < deadline) {
          await new Promise((settle) => setTimeout(settle, 10));
        }
        return target.resolveApproval(...args);
      };
    }
    const value = target[key];
    return typeof value === "function" ? value.bind(target) : value;
  },
});
let question;
const feed = { publishInput: async (asked) => { question ??= asked.key; return asked.key; } };
const interactions = new HarnessInteractions({ approvals: new DatabaseDeferredApprovalStore(kept), askable: true, feed, policy, sessions: new DatabaseSessionStore(kept) });
await interactions.restore();
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
  const grants = () =>
    createAgentAuthorizer({
      grants: new StoredAgentGrantRepository(new DatabaseGrantStorage(kept)),
    });
  try {
    const bridge = new HarnessInteractions({
      approvals: new DatabaseDeferredApprovalStore(kept),
      askable: true,
      feed: openFeed(undefined, { id: "ws", root: dir }).publisher,
      policy: grants(),
      sessions,
    });
    await new Sessions({ store: sessions }).createSession({ id: "session" });
    await bridge.registerSession(
      { agentId: "coder", sessionId: "session", source },
      bridge.authority(source)
    );
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
    // Both restored, then answer together.
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
    // What a later run may do follows the one answer kept.
    await new Sessions({ store: sessions }).createSession({ id: "future" });
    const later = await createHarnessPermission({
      agentId: "coder",
      policy: grants(),
      profile,
      store: sessions,
    })({ ...call, sessionId: "future", toolCallId: "future" });
    expect(later.behavior).toBe(allow?.answered ? "allow" : "deny");
  } finally {
    opened.close();
  }
}, 30_000);
