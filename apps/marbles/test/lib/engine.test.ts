/**
 * The new lib through the real engine: a named definition registered from
 * the catalog, an approval that parks the run as an open feed entry, the
 * dashboard's answer resuming it, reports landing as entries, and the run
 * scope closing when the run settles.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore } from "@foundry/agents/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { step, workflow } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { agent } from "~/authoring/resources";
import type { FeedEntrySnapshot } from "~/lib/feed/read";

import { bindMock } from "../helpers/bindings";
import { startEngine } from "../helpers/engine";
import { openFeed } from "../helpers/feed";

const NOT_RUNNING_PATTERN = /not running here/;
const CANCELLED_PATTERN = /cancelled/;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-lib2-engine-"));
});

afterEach(async () => {
  catalog.reset();
  await rm(root, { force: true, recursive: true });
});

async function openEntry(
  read: () => Promise<FeedEntrySnapshot[]>,
  predicate: (entry: FeedEntrySnapshot) => boolean
) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const entry = (await read()).find(predicate);
    if (entry || Date.now() > deadline) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("lib2 through the engine", () => {
  it("parks on an approval, resumes on the answer, and settles the run scope", async () => {
    step("release").do(async ({ ask, report, run }) => {
      report.milestone({ title: "Ready to release" });
      const { approved, note } = await ask.approval({
        body: "Ship v2?",
        title: "Release v2",
      });
      report.result({ body: approved ? "shipped" : "held", title: "Outcome" });
      return { approved, note, run: run.id };
    });
    const store = openFeed(undefined, { id: "ws", root });
    const engine = await startEngine({
      artifacts: store.artifacts,
      askable: true,
      print: () => undefined,
      root,
    });

    const launched = await engine.launch<{
      approved: boolean;
      note?: string;
      run: string;
    }>("release", {});
    const question = await openEntry(
      store.read,
      (entry) => entry.input?.status === "open"
    );
    expect(question).toMatchObject({
      input: {
        choices: ["approve", "reject"],
        mode: "approval",
        status: "open",
      },
      kind: "input",
      run: launched.id,
      step: "release",
      title: "Release v2",
    });
    expect(engine.scopes.has(launched.id)).toBe(true);
    if (!question) {
      throw new Error("expected an open approval");
    }

    await engine.answer(question.id, {
      choice: "approve",
      note: "after the docs land",
    });
    await expect(launched.result).resolves.toEqual({
      approved: true,
      note: "after the docs land",
      run: launched.id,
    });
    expect(engine.scopes.has(launched.id)).toBe(false);

    const entries = await store.read();
    expect(entries.map((entry) => [entry.kind, entry.title]).sort()).toEqual([
      ["input", "Release v2"],
      ["milestone", "Ready to release"],
      ["result", "Outcome"],
    ]);
    expect(entries.find((entry) => entry.kind === "input")?.input).toEqual({
      answer: "approve",
      choices: ["approve", "reject"],
      mode: "approval",
      note: "after the docs land",
      status: "answered",
    });
    await engine.stop();
  });

  it("a run parked on an approval survives a restart and replays with its ledger", async () => {
    const state = join(root, "state");
    const feedRoot = join(root, "feed");
    const sessions = new InMemorySessionStore();
    const reviewer = agent({ prompt: "Review." });
    const bodies: number[] = [];
    const define = () =>
      step("release").do(async ({ agents, ask, report, run }) => {
        bodies.push(run.session.id.length);
        const session = await agents.session(reviewer);
        const { approved } = await ask.approval({ title: "Release v2" });
        report.result({
          body: JSON.stringify({
            approved,
            runSession: run.session.id,
            session: session.ref.id,
          }),
          title: "Outcome",
        });
        return approved;
      });

    // Process one: park, then quit without cancelling the question.
    define();
    const first = bindMock(() => "ok", { root, sessions });
    const feedOne = openFeed(feedRoot, { id: "ws", root });
    const one = await startEngine({
      ...first.instances,
      artifacts: feedOne.artifacts,
      askable: true,
      print: () => undefined,
      root,
      state,
    });
    const launched = await one.launch<boolean>("release", {});
    launched.result.catch(() => undefined);
    const question = await openEntry(
      feedOne.read,
      (entry) => entry.input?.status === "open"
    );
    if (!question) {
      throw new Error("expected an open approval");
    }
    const scope = one.scopes.get(launched.id);
    const recordedSession = scope?.ledger.toJSON();
    const runSession = scope?.session.id;
    expect(Object.keys(recordedSession ?? {})).toHaveLength(1);
    // Written when it parked, not only at stop: a crash leaves the file too.
    interface ParkedFile {
      run: { status: string };
      suspensions: unknown[];
    }
    const parked = await openEntry(
      async () =>
        (existsSync(join(state, "runs"))
          ? readdirSync(join(state, "runs")).map(
              (name) =>
                JSON.parse(
                  readFileSync(join(state, "runs", name), "utf8")
                ) as ParkedFile
            )
          : []) as never,
      (entry) => (entry as unknown as ParkedFile).run.status === "suspended"
    );
    expect(parked).toBeDefined();
    // The suspension record must be in the file too, or the next process
    // adopts a run it can never answer.
    expect((parked as unknown as ParkedFile).suspensions).toHaveLength(1);
    await one.stop();
    await first.dispose();
    const [file] = readdirSync(join(state, "runs"));
    const saved = JSON.parse(
      readFileSync(join(state, "runs", file as string), "utf8")
    ) as {
      marbles: { ledger: unknown; session: { id: string } };
      run: { status: string };
    };
    expect(saved.run.status).toBe("suspended");
    expect(saved.marbles).toEqual({
      ledger: recordedSession,
      literals: { release: {} },
      session: { id: runSession },
    });
    expect((await feedOne.read())[0]?.input?.status).toBe("open");

    // Process two: adopt the parked run, answer, and finish it.
    catalog.reset();
    define();
    const second = bindMock(() => "ok", { root, sessions });
    const feedTwo = openFeed(feedRoot, { id: "ws", root });
    const lines: string[] = [];
    const two = await startEngine({
      ...second.instances,
      artifacts: feedTwo.artifacts,
      askable: true,
      print: (line) => lines.push(line),
      root,
      state,
    });
    expect(lines).toContain(`[run] release recovered ${launched.id}`);
    const stillOpen = (await feedTwo.read()).find(
      (entry) => entry.id === question.id
    );
    expect(stillOpen?.input?.status).toBe("open");
    await two.answer(question.id, "approve");
    const outcome = await openEntry(
      feedTwo.read,
      (entry) => entry.title === "Outcome"
    );
    expect(JSON.parse(outcome?.body.split("\n").at(-2) ?? "{}")).toEqual({
      approved: true,
      runSession,
      session: Object.values(recordedSession ?? {}).map(
        (ref) => (ref as { id: string }).id
      )[0],
    });
    const done = await openEntry(
      async () =>
        (await two.runs()).map((run) => ({ status: run.status })) as never,
      (entry) => (entry as unknown as { status: string }).status === "complete"
    );
    expect(done).toBeDefined();
    // The body ran once per process; the ledger gave the second run the
    // session the first opened instead of a new one.
    expect(bodies).toHaveLength(2);
    expect(two.scopes.has(launched.id)).toBe(false);
    expect(existsSync(join(state, "runs", file as string))).toBe(true);
    await two.stop();
    await second.dispose();
  });

  it("a quit that cancels running work keeps a parked run for the next process", async () => {
    const state = join(root, "state");
    const feedRoot = join(root, "feed");
    let held: (() => void) | undefined;
    const define = () => {
      step("release").do(async ({ ask }) => {
        const { approved } = await ask.approval({ title: "Release v2" });
        return approved;
      });
      step("linger").do(
        ({ signal }) =>
          new Promise<void>((resolve, reject) => {
            held = resolve;
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          })
      );
    };

    // Process one: one run parked on an approval, one mid-body; the
    // dashboard quits with `cancel`.
    define();
    const first = bindMock(() => "ok", { root });
    const feedOne = openFeed(feedRoot, { id: "ws", root });
    const one = await startEngine({
      ...first.instances,
      artifacts: feedOne.artifacts,
      askable: true,
      print: () => undefined,
      root,
      state,
    });
    const parked = await one.launch<boolean>("release", {});
    parked.result.catch(() => undefined);
    const running = await one.launch<void>("linger", {});
    const lingered = running.result.catch((error: unknown) => error);
    const question = await openEntry(
      feedOne.read,
      (entry) => entry.input?.status === "open"
    );
    if (!question) {
      throw new Error("expected an open approval");
    }
    await one.stop({ cancel: true });
    await first.dispose();
    expect(held).toBeDefined();
    expect(await lingered).toBeInstanceOf(Error);
    const statuses = new Map(
      (await one.runs()).map((run) => [run.id, run.status])
    );
    expect(statuses.get(running.id)).toBe("cancelled");
    expect(statuses.get(parked.id)).toBe("suspended");
    expect(
      (await feedOne.read()).find((entry) => entry.id === question.id)?.input
        ?.status
    ).toBe("open");

    // Process two: the parked run is adopted; the cancelled one is not.
    catalog.reset();
    define();
    const second = bindMock(() => "ok", { root });
    const feedTwo = openFeed(feedRoot, { id: "ws", root });
    const lines: string[] = [];
    const two = await startEngine({
      ...second.instances,
      artifacts: feedTwo.artifacts,
      askable: true,
      print: (line) => lines.push(line),
      root,
      state,
    });
    expect(lines).toContain(`[run] release recovered ${parked.id}`);
    expect(lines).not.toContain(`[run] linger recovered ${running.id}`);
    await two.answer(question.id, "reject");
    const done = await openEntry(
      async () =>
        (await two.runs()).map((run) => ({
          id: run.id,
          status: run.status,
        })) as never,
      (entry) => {
        const run = entry as unknown as { id: string; status: string };
        return run.id === parked.id && run.status === "complete";
      }
    );
    expect(done).toBeDefined();
    await two.stop();
    await second.dispose();
  });

  it("leaves a parked run alone when this process cannot answer or the step is gone", async () => {
    const state = join(root, "state");
    const feedRoot = join(root, "feed");
    step("release").do(
      async ({ ask }) => (await ask.approval({ title: "Go?" })).approved
    );
    const feedOne = openFeed(feedRoot, { id: "ws", root });
    const one = await startEngine({
      artifacts: feedOne.artifacts,
      askable: true,
      print: () => undefined,
      root,
      state,
    });
    const launched = await one.launch<boolean>("release", {});
    launched.result.catch(() => undefined);
    await openEntry(feedOne.read, (entry) => entry.input?.status === "open");
    await one.stop();

    // Not askable: the run is skipped, not adopted, and not cancelled.
    catalog.reset();
    step("release").do(
      async ({ ask }) => (await ask.approval({ title: "Go?" })).approved
    );
    const lines: string[] = [];
    const quiet = await startEngine({
      artifacts: openFeed(feedRoot, { id: "ws", root }).artifacts,
      print: (line) => lines.push(line),
      root,
      state,
    });
    expect((await quiet.runs()).map((run) => run.id)).not.toContain(
      launched.id
    );
    expect(lines.join("\n")).toContain("nothing here can resume it");
    await quiet.stop();

    // Askable, but the step was renamed: skipped with a warning, no crash.
    catalog.reset();
    step("ship").do(
      async ({ ask }) => (await ask.approval({ title: "Go?" })).approved
    );
    const renamed: string[] = [];
    const later = await startEngine({
      artifacts: openFeed(feedRoot, { id: "ws", root }).artifacts,
      askable: true,
      print: (line) => renamed.push(line),
      root,
      state,
    });
    expect((await later.runs()).map((run) => run.id)).not.toContain(
      launched.id
    );
    expect(renamed.join("\n")).toContain("nothing here can resume it");
    await later.stop();
  });

  it("pauses a running step and resumes it with a prompt on the recorded session", async () => {
    const prompts: string[] = [];
    const mock = bindMock(
      ({ prompt }) => {
        prompts.push(prompt);
        return "ok";
      },
      { root }
    );
    const reviewer = agent({ prompt: "Review." });
    let release: () => void = () => undefined;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts: string[] = [];
    step("review").do(async ({ agents, signal, stream }) => {
      const session = await agents.session(reviewer);
      attempts.push(session.ref.id);
      const reply = await session.generate("look at the tests");
      stream.write("waiting\n");
      // The step parks only once its attempt stops, so the wait honours the signal.
      await Promise.race([
        gate,
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      ]);
      return reply.text;
    });
    const engine = await startEngine({
      ...mock.instances,
      print: () => undefined,
      root,
    });
    const launched = await engine.launch<string>("review", {});
    const status = async (wanted: string) =>
      openEntry(
        async () =>
          (await engine.runs())
            .filter((run) => run.id === launched.id)
            .map((run) => ({ status: run.status })) as never,
        (entry) => (entry as unknown as { status: string }).status === wanted
      );
    // Let the body reach its wait, then park it.
    await openEntry(
      async () => (attempts.length > 0 ? [{}] : []) as never,
      () => true
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.pause(launched.id, "review", "hold")).toBe(true);
    expect(await status("suspended")).toBeDefined();
    expect(engine.pause(launched.id, "review")).toBe(false);

    // Resume with a prompt: the body replays, the session is the same one,
    // and the prompt leads its first turn.
    gate = Promise.resolve();
    release();
    await engine.resume(launched.id, "review", "focus on flaky ones");
    await expect(launched.result).resolves.toBe("ok");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("focus on flaky ones\n\nlook at the tests");
    await expect(engine.resume(launched.id, "review", "again")).rejects.toThrow(
      NOT_RUNNING_PATTERN
    );
    await engine.stop();
    await mock.dispose();
  });

  it("pausing a workflow root parks its running child, and nothing runs after the cut turn", async () => {
    const mock = bindMock(
      ({ prompt }) => `reply to ${prompt.split("\n").at(-1) ?? ""}`,
      { hold: ({ prompt }) => prompt.endsWith("count slowly"), root }
    );
    const reviewer = agent({ prompt: "Review." });
    const after: string[] = [];
    let turns = 0;
    let stop: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const child = step("child").do(async ({ agents, signal }) => {
      const session = await agents.session(reviewer);
      turns += 1;
      const turn = session.generate(turns === 1 ? "count slowly" : "again");
      if (turns === 1) {
        // The mock holds this turn until its signal fires.
        await new Promise((resolve) => setTimeout(resolve, 20));
        stop?.();
      }
      const reply = await turn;
      after.push(signal.aborted ? "ran while aborted" : "ran");
      return reply.text;
    });
    const parent = step("parent")
      .input(z.object({ text: z.string() }))
      .do(({ input }) => input.text.toUpperCase());
    workflow("flow", parent({ text: child({}) }));
    const engine = await startEngine({
      ...mock.instances,
      print: () => undefined,
      root,
    });
    const launched = await engine.launch<string>("flow", {});
    await started;
    expect(engine.pause(launched.id, "flow", "hold")).toBe(true);
    const parked = await openEntry(
      async () =>
        (await engine.runs())
          .filter((run) => run.id === launched.id && run.status === "suspended")
          .map(() => ({})) as never,
      () => true
    );
    expect(parked).toBeDefined();
    expect(after).toEqual([]);
    await engine.resume(launched.id, "flow");
    await expect(launched.result).resolves.toBe("REPLY TO AGAIN");
    expect(after).toEqual(["ran"]);
    expect(turns).toBe(2);
    await engine.stop();
    await mock.dispose();
  });

  it("writes the answer to the run file before the run goes on", async () => {
    const state = join(root, "state");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    step("gated").do(async ({ ask, signal }) => {
      const { approved } = await ask.approval({ title: "Go?" });
      await Promise.race([
        gate,
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      ]);
      return approved;
    });
    const store = openFeed(undefined, { id: "ws", root });
    const engine = await startEngine({
      artifacts: store.artifacts,
      askable: true,
      print: () => undefined,
      root,
      state,
    });
    const launched = await engine.launch<boolean>("gated", {});
    const question = await openEntry(
      store.read,
      (entry) => entry.input?.status === "open"
    );
    if (!question) {
      throw new Error("expected an open approval");
    }
    const file = join(state, "runs", `${launched.id}.json`);
    const read = () =>
      JSON.parse(readFileSync(file, "utf8")) as {
        run: { status: string };
        suspensions: { status: string }[];
      };
    expect(read().run.status).toBe("suspended");
    await engine.answer(question.id, "approve");
    // The body is still held at its gate; the file already says the
    // question is answered and the run is under way.
    const moved = await openEntry(
      async () => (read().run.status === "suspended" ? [] : [{}]) as never,
      () => true
    );
    expect(moved).toBeDefined();
    expect(read().suspensions.map((item) => item.status)).toEqual(["resolved"]);
    release?.();
    await expect(launched.result).resolves.toBe(true);
    expect(read().run.status).toBe("complete");
    await engine.stop();
  });

  it("adopting a parked run claims it: the file names the new owner and a lock is held", async () => {
    const state = join(root, "state");
    const feedRoot = join(root, "feed");
    const define = () =>
      step("release").do(
        async ({ ask }) => (await ask.approval({ title: "Go?" })).approved
      );
    define();
    const one = await startEngine({
      artifacts: openFeed(feedRoot, { id: "ws", root }).artifacts,
      askable: true,
      print: () => undefined,
      root,
      state,
    });
    const launched = await one.launch<boolean>("release", {});
    launched.result.catch(() => undefined);
    const feedOne = openFeed(feedRoot, { id: "ws", root });
    const question = await openEntry(
      feedOne.read,
      (entry) => entry.input?.status === "open"
    );
    await one.stop();

    catalog.reset();
    define();
    const rebound = bindMock(() => "ok", { root });
    const two = await startEngine({
      ...rebound.instances,
      artifacts: openFeed(feedRoot, { id: "ws", root }).artifacts,
      askable: true,
      print: () => undefined,
      root,
      state,
    });
    const file = join(state, "runs", `${launched.id}.json`);
    const lock = join(state, "locks", `run-${launched.id}`);
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));

    // A second process that finds the same file cannot take the run too.
    const lines: string[] = [];
    const three = await startEngine({
      ...rebound.instances,
      askable: true,
      print: (line) => lines.push(line),
      root,
      state,
    });
    expect((await three.runs()).map((run) => run.id)).not.toContain(
      launched.id
    );
    expect(lines.join("\n")).toContain(
      `run is suspended in pid ${String(process.pid)}`
    );
    await three.stop();
    expect(existsSync(lock)).toBe(true);

    if (!question) {
      throw new Error("expected an open approval");
    }
    await two.answer(question.id, "approve");
    await openEntry(
      async () =>
        (await two.runs())
          .filter((run) => run.id === launched.id && run.status === "complete")
          .map(() => ({})) as never,
      () => true
    );
    expect(existsSync(lock)).toBe(false);
    await two.stop();
    await rebound.dispose();
  });

  it("a recovered step runs with the input it was locked with, not a rebuilt one", async () => {
    const state = join(root, "state");
    const feedRoot = join(root, "feed");
    let seed = 1;
    const define = () => {
      const tally = step("tally")
        .input(z.object({ n: z.number() }))
        .do(async ({ ask, input }) => {
          await ask.approval({ title: "Count?" });
          return input.n;
        });
      workflow("counting").do(() => tally({}, { n: seed }));
    };
    define();
    const one = await startEngine({
      artifacts: openFeed(feedRoot, { id: "ws", root }).artifacts,
      askable: true,
      print: () => undefined,
      root,
      state,
    });
    const launched = await one.launch<number>("counting", {});
    launched.result.catch(() => undefined);
    const feed = openFeed(feedRoot, { id: "ws", root });
    const question = await openEntry(
      feed.read,
      (entry) => entry.input?.status === "open"
    );
    await one.stop();
    const file = JSON.parse(
      readFileSync(join(state, "runs", `${launched.id}.json`), "utf8")
    ) as { marbles: { literals: Record<string, unknown> } };
    expect(file.marbles.literals).toEqual({ counting: { n: 1 } });

    // The setup would now lock a different value; the recovered run keeps its own.
    seed = 2;
    catalog.reset();
    define();
    const rebound = bindMock(() => "ok", { root });
    const two = await startEngine({
      ...rebound.instances,
      artifacts: openFeed(feedRoot, { id: "ws", root }).artifacts,
      askable: true,
      print: () => undefined,
      root,
      state,
    });
    if (!question) {
      throw new Error("expected an open approval");
    }
    await two.answer(question.id, "approve");
    const done = await openEntry(
      async () =>
        (await two.runs())
          .filter((run) => run.id === launched.id && run.status === "complete")
          .map((run) => ({ output: run.output })) as never,
      () => true
    );
    expect((done as unknown as { output: number }).output).toBe(1);
    await two.stop();
    await rebound.dispose();
  });

  it("cancelling a parked run closes its question", async () => {
    step("release").do(
      async ({ ask }) => (await ask.approval({ title: "Go?" })).approved
    );
    const store = openFeed(undefined, { id: "ws", root });
    const engine = await startEngine({
      artifacts: store.artifacts,
      askable: true,
      print: () => undefined,
      root,
    });
    const launched = await engine.launch<boolean>("release", {});
    const question = await openEntry(
      store.read,
      (entry) => entry.input?.status === "open"
    );
    if (!question) {
      throw new Error("expected an open approval");
    }
    await engine.cancel(launched.id);
    await expect(launched.result).rejects.toThrow(CANCELLED_PATTERN);
    const closed = await openEntry(
      store.read,
      (entry) => entry.id === question.id && entry.input?.status === "cancelled"
    );
    expect(closed).toBeDefined();
    await expect(engine.answer(question.id, "approve")).rejects.toThrow(
      "no longer waiting"
    );
    await engine.stop();
  });

  it("a launch with input the schema rejects fails at dispatch, parsing once", async () => {
    let parsed = 0;
    step("typed")
      .input(
        z.object({
          n: z.string().transform((value) => {
            parsed += 1;
            return Number(value);
          }),
        })
      )
      .do(({ input }) => input.n);
    const engine = await startEngine({
      print: () => undefined,
      root,
    });
    await expect(engine.launch("typed", { n: 3 })).rejects.toThrow(
      '"typed" input'
    );
    expect((await engine.runs()).length).toBe(0);
    await expect(engine.run<number>("typed", { n: "2" })).resolves.toBe(2);
    expect(parsed).toBe(1);
    await engine.stop();
  });

  it("cancels one run", async () => {
    step("wait").do(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })
    );
    const engine = await startEngine({
      print: () => undefined,
      root,
    });
    const launched = await engine.launch("wait", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    await engine.cancel(launched.id);
    await expect(launched.result).rejects.toThrow(CANCELLED_PATTERN);
    await engine.stop();
  });

  it("a parallel child that asks parks the run and its sibling finishes", async () => {
    const sibling: string[] = [];
    const asks = step("asks").do(async ({ ask }) =>
      (await ask.approval({ title: "Go?" })).approved ? "yes" : "no"
    );
    const slow = step("slow").do(async ({ signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      sibling.push(signal.aborted ? "aborted" : "done");
      return "slow";
    });
    const both = step("both")
      .input(z.object({ a: z.string(), b: z.string() }))
      .do(({ input }) => `${input.a}+${input.b}`);
    workflow("pair", both.parallel({ a: asks({}), b: slow({}) }));
    const store = openFeed(undefined, { id: "ws", root });
    const engine = await startEngine({
      artifacts: store.artifacts,
      askable: true,
      print: () => undefined,
      root,
    });
    const launched = await engine.launch<string>("pair", {});
    const question = await openEntry(
      store.read,
      (entry) => entry.input?.status === "open"
    );
    if (!question) {
      throw new Error("expected an open approval");
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sibling).toEqual(["done"]);
    await engine.answer(question.id, "approve");
    await expect(launched.result).resolves.toBe("yes+slow");
    await engine.stop();
  });
});
