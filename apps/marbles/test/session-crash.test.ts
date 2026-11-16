import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { type TestHome, testHome } from "./helpers/home";

const SRC = resolve("src");
const HELPERS = resolve("test/helpers");
const PROCESS_TIMEOUT = 60_000;
const TEST_TIMEOUT = 180_000;

function host(home: TestHome, name: string, body: string): string {
  const script = join(home.path, `${name}.ts`);
  const state = join(home.path, "state");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
import { agent, step } from ${JSON.stringify(join(SRC, "authoring/index.ts"))};
import { openWorkspaceDatabase } from ${JSON.stringify(join(SRC, "database/managed.ts"))};
import { testEngine } from ${JSON.stringify(join(HELPERS, "engine.ts"))};
const state = ${JSON.stringify(state)};
const reviewer = agent({ prompt: "Review." });
step("talk").do(async ({ agents }) => {
  const session = await agents.session(reviewer);
  writeFileSync(${JSON.stringify(join(home.path, "ref.json"))}, JSON.stringify(session.ref));
  return (await session.generate("count slowly")).text;
});
const kept = openWorkspaceDatabase({ state, workspaceId: "test" });
const engine = testEngine({
  hold: ({ prompt }) => prompt.endsWith("count slowly"),
  print: () => undefined,
  reply: ({ prompt }) => "reply to " + prompt.split("\\n").at(-1),
  sessions: kept.sessions,
  state,
});
await engine.start();
const transcript = kept.sessions;
const report = { pid: process.pid };
${body}
await engine.dispose();
await kept.close();
process.stdout.write(JSON.stringify(report) + "\\n");
process.exit(0);
`
  );
  return script;
}

async function waitFor<T>(find: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + PROCESS_TIMEOUT;
  for (;;) {
    const found = await find();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

function exited(child: ChildProcess): Promise<unknown> {
  return child.exitCode === null && child.signalCode === null
    ? new Promise((done) => child.once("exit", done))
    : Promise.resolve();
}

it(
  "a session cut mid-turn by a killed host is readable, and its next turn runs",
  async () => {
    const home = testHome();
    const refFile = join(home.path, "ref.json");
    const first = spawn(
      "bun",
      [
        host(
          home,
          "cut",
          `await engine.launch("talk", {});
await new Promise(() => undefined);`
        ),
      ],
      {
        cwd: resolve("."),
        env: home.env,
        stdio: ["ignore", "ignore", "inherit"],
      }
    );
    home.track(first.pid, false);
    const ref = await waitFor(() =>
      Promise.resolve(
        existsSync(refFile)
          ? (JSON.parse(readFileSync(refFile, "utf8")) as { id: string })
          : undefined
      )
    );
    const peek = host(
      home,
      "peek",
      `report.roles = (await transcript.listMessages(${JSON.stringify(ref.id)})).map((m) => m.role);`
    );
    await waitFor(() => {
      const { roles } = JSON.parse(
        execFileSync("bun", [peek], {
          cwd: resolve("."),
          encoding: "utf8",
          env: home.env,
          timeout: PROCESS_TIMEOUT,
        })
          .trim()
          .split("\n")
          .at(-1) ?? "{}"
      ) as { roles: string[] };
      return Promise.resolve(roles.includes("user") ? roles : undefined);
    });
    first.kill("SIGKILL");
    await exited(first);

    const next = host(
      home,
      "next",
      `const ref = ${JSON.stringify(ref)};
report.before = (await transcript.listMessages(ref.id)).map((m) => ({ role: m.role, status: m.status }));
const session = await engine.agents.session(reviewer, { session: ref });
report.reply = (await session.generate("again")).text;
report.after = (await transcript.listMessages(ref.id)).map((m) => ({ role: m.role, status: m.status }));`
    );
    const report = JSON.parse(
      execFileSync("bun", [next], {
        cwd: resolve("."),
        encoding: "utf8",
        env: home.env,
        timeout: PROCESS_TIMEOUT,
      })
        .trim()
        .split("\n")
        .at(-1) ?? "{}"
    ) as {
      after: { role: string; status: string }[];
      before: { role: string; status: string }[];
      reply: string;
    };
    const user = { role: "user", status: "complete" };
    expect(report.before).toEqual([user]);
    expect(report.reply).toBe("reply to again");
    expect(report.after).toEqual([
      user,
      user,
      { role: "assistant", status: "complete" },
    ]);
  },
  TEST_TIMEOUT
);
