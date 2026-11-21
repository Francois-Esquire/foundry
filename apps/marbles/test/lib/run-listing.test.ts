import { ExecutionCoordinator } from "@foundry/workflows";
import { expect, it, vi } from "vitest";
import { RunListing } from "~/lib/run-listing";

async function arranged() {
  const store = new ExecutionCoordinator();
  const queue = await store.ensureQueue({ id: "qu-1", name: "marbles" });
  const put = async (
    id: string,
    status: "complete" | "running",
    createdAt: number
  ) => {
    await store.createRun({ id, input: null, queueId: queue.id, step: "s" });
    await store.updateRun(id, {
      status: "running",
      timestamps: { createdAt },
    });
    if (status === "complete") {
      await store.updateRun(id, { status });
    }
  };
  return { put, store };
}

it("lists the settled Runs retained at start and its own since, never another process's live one", async () => {
  const { put, store } = await arranged();
  await put("rn-old", "complete", 1);
  await put("rn-elsewhere", "running", 2);
  const listing = new RunListing(store);
  await listing.load();
  await put("rn-mine", "running", 3);
  listing.add("rn-mine");

  expect((await listing.list()).map((run) => run.id)).toEqual([
    "rn-old",
    "rn-mine",
  ]);
  listing.remove("rn-old");
  expect((await listing.list()).map((run) => run.id)).toEqual(["rn-mine"]);
});

it("reads a settled Run once, and only its live Runs on every listing after", async () => {
  const { put, store } = await arranged();
  for (let i = 0; i < 5; i += 1) {
    await put(`rn-${String(i)}`, "complete", i);
  }
  const listing = new RunListing(store);
  await listing.load();
  await put("rn-live", "running", 10);
  listing.add("rn-live");
  const listRuns = vi.spyOn(store, "listRuns");
  const getRun = vi.spyOn(store, "getRun");

  expect(await listing.list()).toHaveLength(6);
  await store.updateRun("rn-live", { status: "complete" });
  expect((await listing.list()).at(-1)?.status).toBe("complete");
  expect(await listing.list()).toHaveLength(6);

  expect(listRuns).not.toHaveBeenCalled();
  expect(getRun).toHaveBeenCalledTimes(2);
});

it("lists each Run once when listings overlap, whichever finds it settled", async () => {
  const { put, store } = await arranged();
  await put("rn-a", "running", 1);
  await put("rn-b", "running", 2);
  const listing = new RunListing(store);
  await listing.load();
  listing.add("rn-a");
  listing.add("rn-b");
  await store.updateRun("rn-a", { status: "complete" });

  const listed = await Promise.all([listing.list(), listing.list()]);
  for (const runs of listed) {
    expect(runs.map((run) => run.id)).toEqual(["rn-a", "rn-b"]);
  }
});

it("lists no Run pruned while a listing was reading it", async () => {
  const { put, store } = await arranged();
  await put("rn-a", "running", 1);
  const listing = new RunListing(store);
  await listing.load();
  listing.add("rn-a");
  const getRun = store.getRun.bind(store);
  vi.spyOn(store, "getRun").mockImplementation(async (id) => {
    const run = await getRun(id);
    listing.remove(id);
    return run;
  });

  expect(await listing.list()).toEqual([]);
});

it("lists a Run once when another listing finds it settled after this one read it live", async () => {
  const { put, store } = await arranged();
  await put("rn-a", "running", 1);
  await put("rn-b", "running", 2);
  const listing = new RunListing(store);
  await listing.load();
  listing.add("rn-a");
  listing.add("rn-b");
  let release = (): void => undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const getRun = store.getRun.bind(store);
  let held = false;
  vi.spyOn(store, "getRun").mockImplementation(async (id) => {
    if (id === "rn-b" && !held) {
      held = true;
      await gate;
    }
    return await getRun(id);
  });

  const first = listing.list();
  await vi.waitFor(() => expect(held).toBe(true));
  await store.updateRun("rn-a", { status: "complete" });
  expect((await listing.list()).map((run) => run.id)).toEqual(["rn-a", "rn-b"]);
  release();
  expect((await first).map((run) => run.id)).toEqual(["rn-a", "rn-b"]);
});

it("learns a retained run completed by another generation after loading, without listing it live", async () => {
  const { put, store } = await arranged();
  await put("rn-elsewhere", "running", 1);
  const listing = new RunListing(store);
  await listing.load();
  const getRun = vi.spyOn(store, "getRun");
  expect(await listing.list()).toEqual([]);
  await store.updateRun("rn-elsewhere", {
    output: "finished elsewhere",
    status: "complete",
  });
  const completed = await listing.list();
  expect(completed).toMatchObject([
    { id: "rn-elsewhere", output: "finished elsewhere", status: "complete" },
  ]);
  getRun.mockClear();
  expect(await listing.list()).toEqual(completed);
  expect(getRun).not.toHaveBeenCalled();
});
