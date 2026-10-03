import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
import { step } from "@foundry/quirks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { formatCount } from "~/components/ui/count-badge";
import { startEngine } from "~/engine";
import { feedPayload, feedQuestionSchema } from "~/feed/entry";
import { feedPublisher } from "~/feed/publish";
import { feedReader, formatPosted } from "~/feed/read";
import { registerSetupStep, SETUP_STEP } from "~/feed/setup";
import type { FeedStore } from "~/feed/store";
import { openFeed } from "~/feed/store";
import { catalog } from "~/lib/catalog";
import { createLog, formatLogValues } from "~/lib/log";
import { runs } from "~/lib/run-scope";
import { registerCatalog } from "~/lib/tree";
import { bindRuntime } from "~/runtime";
import type { FeedEntrySnapshot } from "~/views/dashboard-model";

const MISSING_TITLE = /feed entries need a title/;
const UNREADABLE_MEDIA = /cannot read media/;
const NOTE_TOO_LONG = /under 2000/;
const NOT_A_CHOICE = /Choose one of: yes, no/;
const NO_LONGER_WAITING = /no longer waiting/;
const CANCELLED = /cancelled/;
// Smallest valid PNG: 1x1, one transparent pixel.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quirks-feed-"));
});

afterEach(async () => {
  catalog.reset();
  runs.clear();
  await rm(root, { force: true, recursive: true });
});

function workspace(id = "ws-a", path = join(root, "project")) {
  return { id, root: path };
}

/** A dry runtime over the feed's own artifact store, bound to the catalog. */
function bind(store: FeedStore) {
  return bindRuntime({
    artifacts: store.artifacts,
    dry: true,
    only: [],
    print: () => undefined,
    root,
    workspaceId: "ws-a",
  });
}

describe("feed posts", () => {
  it("validate where the step called them and resolve media from the workspace", async () => {
    expect(() =>
      feedPayload({ key: "k", kind: "result", title: " " }, root)
    ).toThrow(MISSING_TITLE);
    expect(() =>
      feedPayload(
        { key: "k", kind: "result", media: ["missing.png"], title: "T" },
        root
      )
    ).toThrow(UNREADABLE_MEDIA);
    await writeFile(join(root, "chart.png"), PNG);
    expect(
      feedPayload(
        { key: "k", kind: "result", media: ["chart.png"], title: "T" },
        root
      ).media
    ).toEqual([join(root, "chart.png")]);
  });
});

describe("feed store", () => {
  it("publishes an Artifact per key and updates it when the key repeats", async () => {
    const feed = openFeed(join(root, "artifacts"), workspace());
    const source = { definition: "summary", path: ["summary"], runId: "rn-1" };
    const first = await feed.publisher.publish(
      {
        body: "draft",
        key: "report",
        kind: "result",
        media: [],
        title: "Draft",
      },
      source
    );
    const second = await feed.publisher.publish(
      {
        body: "final",
        key: "report",
        kind: "result",
        media: [],
        title: "Final",
      },
      source
    );
    expect(second).toBe(first);

    const entries = await feed.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      body: "# Final\n\nfinal\n",
      definition: "summary",
      run: "rn-1",
      step: "summary",
      title: "Final",
      workspace: { id: "ws-a", name: "project" },
    });
  });

  it("copies media into the entry and loads images for the reader", async () => {
    const chart = join(root, "chart.png");
    const clip = join(root, "clip.mp4");
    await writeFile(chart, PNG);
    await writeFile(clip, "not really a video");
    const feed = openFeed(join(root, "artifacts"), workspace());
    await feed.publisher.publish(
      {
        body: "![chart](media/chart.png)",
        key: "chart",
        kind: "result",
        media: [chart, clip],
        title: "Chart",
      },
      { definition: "plot", path: ["plot"], runId: "rn-2" }
    );
    await rm(chart);

    const [entry] = await feed.read();
    expect(entry?.media.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: "image", path: "media/chart.png" },
      { kind: "video", path: "media/clip.mp4" },
    ]);
    expect(Buffer.from(entry?.media[0]?.bytes ?? [])).toEqual(PNG);
  });

  it("shares one store across workspaces and processes, newest first", async () => {
    const artifacts = join(root, "artifacts");
    const a = openFeed(artifacts, workspace("ws-a", join(root, "alpha")));
    const b = openFeed(artifacts, workspace("ws-b", join(root, "beta")));
    const post = (title: string) => ({
      body: "",
      key: title,
      kind: "milestone" as const,
      media: [],
      title,
    });
    await a.publisher.publish(post("older"), {
      definition: "d",
      path: ["d"],
      runId: "rn-a",
    });
    await b.publisher.publish(post("newer"), {
      definition: "d",
      path: ["d"],
      runId: "rn-b",
    });

    const entries = await openFeed(artifacts, workspace()).read();
    expect(entries.map((entry) => [entry.title, entry.workspace.name])).toEqual(
      [
        ["newer", "beta"],
        ["older", "alpha"],
      ]
    );
  });
});

describe("engine", () => {
  it("attributes a step's reports to its run and step before the run settles", async () => {
    const store = openFeed(undefined, workspace());
    const runtime = bind(store);
    step("summarize")
      .input(z.object({ text: z.string() }))
      .do(({ input, report }) => {
        report.result({ body: input.text, key: "summary", title: "Summary" });
        return input.text;
      });
    const engine = await startEngine(registerCatalog, {
      feed: store.publisher,
      print: () => undefined,
    });

    const launched = await engine.launch<string>("summarize", {
      text: "all good",
    });
    await expect(launched.result).resolves.toBe("all good");
    await engine.stop();

    const [entry] = await store.read();
    expect(entry).toMatchObject({
      body: "# Summary\n\nall good\n",
      definition: "summarize",
      kind: "result",
      run: launched.id,
      step: "summarize",
    });
    await runtime.dispose();
  });
});

describe("questions", () => {
  function askingStep() {
    const store = openFeed(undefined, workspace());
    const runtime = bind(store);
    step("deploy")
      .input(z.object({ version: z.string() }))
      .do(async ({ ask, input }) => {
        const answer = await ask.question({
          body: `Deploy ${input.version}?`,
          choices: ["yes", "no"],
          key: "confirm",
          title: "Deploy?",
        });
        return `${input.version}:${answer}`;
      });
    return { runtime, store };
  }

  async function openQuestion(read: () => Promise<FeedEntrySnapshot[]>) {
    const deadline = Date.now() + 3000;
    for (;;) {
      const entry = (await read()).find(
        (item) => item.input?.status === "open"
      );
      if (entry || Date.now() > deadline) {
        return entry;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("pause the run on an open entry and resume it with the answer", async () => {
    const { runtime, store } = askingStep();
    const engine = await startEngine(registerCatalog, {
      askable: true,
      feed: store.publisher,
      print: () => undefined,
    });
    const launched = await engine.launch<string>("deploy", { version: "v2" });
    const question = await openQuestion(store.read);
    expect(question).toMatchObject({
      input: { choices: ["yes", "no"], mode: "question", status: "open" },
      kind: "input",
      run: launched.id,
      step: "deploy",
      title: "Deploy?",
    });
    expect(question?.body).toContain("Deploy v2?");
    if (!question) {
      throw new Error("expected an open question");
    }

    await expect(engine.answer(question.id, "maybe")).rejects.toThrow(
      NOT_A_CHOICE
    );
    await expect(
      engine.answer(question.id, { choice: "maybe", note: "x" })
    ).rejects.toThrow(NOT_A_CHOICE);
    await expect(
      engine.answer(question.id, { choice: "yes", note: "n".repeat(2001) })
    ).rejects.toThrow(NOTE_TOO_LONG);
    await engine.answer(question.id, "yes");
    await expect(launched.result).resolves.toBe("v2:yes");
    const [answered] = await store.read();
    expect(answered?.input).toEqual({
      answer: "yes",
      choices: ["yes", "no"],
      mode: "question",
      status: "answered",
    });
    expect(answered?.body).toContain("> Answered: yes");
    await expect(engine.answer(question.id, "no")).rejects.toThrow(
      NO_LONGER_WAITING
    );
    await engine.stop();
    await runtime.dispose();
  });

  it("cancel the run when nothing in the process can answer", async () => {
    const { runtime, store } = askingStep();
    const lines: string[] = [];
    const engine = await startEngine(registerCatalog, {
      feed: store.publisher,
      print: (line) => lines.push(line),
    });
    await expect(engine.run("deploy", { version: "v2" })).rejects.toThrow(
      CANCELLED
    );
    const [entry] = await store.read();
    expect(entry?.input?.status).toBe("cancelled");
    expect(lines.join("\n")).toContain('"Deploy?" needs an answer');
    await engine.stop();
    await runtime.dispose();
  });

  it("mark open questions cancelled when the engine stops", async () => {
    const { runtime, store } = askingStep();
    const engine = await startEngine(registerCatalog, {
      askable: true,
      feed: store.publisher,
      print: () => undefined,
    });
    const launched = await engine.launch<string>("deploy", { version: "v2" });
    launched.result.catch(() => undefined);
    await openQuestion(store.read);
    await engine.stop({ cancel: true });
    const [entry] = await store.read();
    expect(entry?.input?.status).toBe("cancelled");
    await runtime.dispose();
  });
});

describe("abandoned questions", () => {
  it("preserves live delivery through answer updates and deferred permission across restart", async () => {
    const location = join(root, "artifacts");
    const store = openFeed(location, workspace());
    const source = { definition: "d", path: ["d"], runId: "rn-1" };
    const question = feedQuestionSchema.parse({
      choices: ["Approve once", "Allow for this session", "Deny"],
      delivery: "live",
      key: "live",
      mode: "approval",
      title: "Allow tool?",
    });
    const live = await store.publisher.publishInput(question, source, {
      status: "open",
    });
    const deferred = await store.publisher.publishInput(
      { ...question, delivery: "deferred", key: "future" },
      source,
      { status: "open" }
    );
    const reopened = openFeed(location, workspace());
    expect(
      (await reopened.read()).find((entry) => entry.id === live)?.input
        ?.delivery
    ).toBe("live");
    await reopened.publisher.publishInput(question, source, {
      answer: "Approve once",
      status: "answered",
    });
    expect(
      (await reopened.read()).find((entry) => entry.id === live)?.input
    ).toMatchObject({
      answer: "Approve once",
      delivery: "live",
      status: "answered",
    });
    const abandoned = await reopened.publisher.publishInput(
      { ...question, key: "abandoned-live" },
      source,
      { status: "open" }
    );
    const sweeper = feedPublisher(
      reopened.artifacts,
      { ...workspace(), name: "a" },
      { isAlive: () => false }
    );
    expect(await sweeper.cancelAbandoned()).toBe(1);
    expect(
      (await reopened.read()).find((entry) => entry.id === abandoned)?.input
    ).toMatchObject({ delivery: "live", status: "cancelled" });
    expect(
      (await reopened.read()).find((entry) => entry.id === deferred)?.input
    ).toMatchObject({ delivery: "deferred", status: "open" });
  });

  it("cancel open questions whose process exited and keep live ones", async () => {
    const artifacts = new ArtifactSystem({
      store: new InMemoryArtifactStore(),
    });
    const site = { id: "ws-a", name: "a", root };
    const question = (key: string) => ({
      body: `Context for ${key}`,
      choices: ["yes", "no"],
      key,
      mode: "question" as const,
      title: key,
    });
    const source = { definition: "d", path: ["d"], runId: "rn-1" };
    await feedPublisher(artifacts, site, { pid: 111 }).publishInput(
      question("crashed"),
      source,
      { status: "open" }
    );
    await feedPublisher(artifacts, site, { pid: 222 }).publishInput(
      question("running"),
      source,
      { status: "open" }
    );

    const sweeper = feedPublisher(artifacts, site, {
      isAlive: (pid) => pid === 222,
    });
    await expect(sweeper.cancelAbandoned()).resolves.toBe(1);
    await expect(sweeper.cancelAbandoned()).resolves.toBe(0);

    const entries = await feedReader(artifacts)();
    const status = Object.fromEntries(
      entries.map((entry) => [entry.title, entry.input?.status])
    );
    expect(status).toEqual({ crashed: "cancelled", running: "open" });
    const crashed = entries.find((entry) => entry.title === "crashed");
    expect(crashed?.body).toContain("Context for crashed");
    expect(crashed?.body).toContain("> No longer waiting");
  });
});

describe("onboarding", () => {
  it("posts the setup milestone from its own run", async () => {
    const store = openFeed(undefined, workspace());
    const engine = await startEngine(registerSetupStep, {
      feed: store.publisher,
      print: () => undefined,
    });
    await engine.run(SETUP_STEP, {
      configPath: join(root, "quirks.config.ts"),
      draft: {
        harness: "auto",
        instructions: "",
        name: "summarize-codebase",
        template: "product",
      },
      root,
    });
    await engine.stop();

    const [entry] = await store.read();
    expect(entry).toMatchObject({
      kind: "milestone",
      step: SETUP_STEP,
    });
    expect(entry?.body).toContain("`summarize-codebase`");
  });
});

describe("log", () => {
  it("formats any value and routes each level", () => {
    const lines: [string, string][] = [];
    const log = createLog((level, message) => lines.push([level, message]));
    log("count", 3, { nested: { ok: true } });
    log.warn(new Error("careful"));
    expect(lines[0]).toEqual(["info", "count 3 { nested: { ok: true } }"]);
    expect(lines[1]?.[0]).toBe("warn");
    expect(lines[1]?.[1]).toContain("Error: careful");
    expect(formatLogValues([])).toBe("");
  });
});

describe("tab badges", () => {
  it("cap at 99+", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(99)).toBe("99");
    expect(formatCount(100)).toBe("99+");
  });
});

describe("posted times", () => {
  it("show the time today and the date otherwise", () => {
    const now = new Date(2026, 8, 22, 18, 0);
    expect(formatPosted(new Date(2026, 8, 22, 9, 5), now)).toBe("09:05");
    expect(formatPosted(new Date(2026, 8, 21, 14, 30), now)).toBe(
      "Sep 21 14:30"
    );
  });
});
