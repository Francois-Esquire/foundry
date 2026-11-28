import { describe, expect, it, vi } from "vitest";
import { createContainers } from "../containers/containers";
import { createFakeDriver } from "../testing/index";
import { CONTAINER_SPEC, newStore } from "./helpers/containers-fixture";

function fixture() {
  const runtime = createFakeDriver();
  const store = newStore();
  const containers = createContainers({
    driver: runtime,
    instanceLabel: "lifecycle",
    store,
  });
  return { containers, runtime, store };
}

describe("get", () => {
  it("reads one row without listing the store", async () => {
    const { containers, store } = fixture();
    const handle = await containers.start(CONTAINER_SPEC);
    const list = vi.spyOn(store, "list");

    expect(await containers.get(handle.id)).toMatchObject({
      id: handle.id,
      status: "running",
    });
    expect(await containers.get("unknown")).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    await containers.shutdown();
  });
});

describe("a restart whose old VM will not go", () => {
  it("marks the row failed, evicts the live entry and keeps the VM to retry", async () => {
    const { containers, runtime, store } = fixture();
    const handle = await containers.start(CONTAINER_SPEC);
    const [old] = runtime.handles;
    if (old === undefined) {
      throw new Error("expected a booted instance");
    }
    vi.spyOn(old, "remove").mockRejectedValue(new Error("stuck"));

    await expect(containers.restart(handle.id)).rejects.toThrow("stuck");

    expect((await store.get(handle.id))?.status).toBe("failed");
    expect(runtime.handles).toHaveLength(1);
    expect(await containers.sweep()).toEqual([`${handle.id}-1`]);
    const reopened = await containers.open(handle.id);
    expect(reopened.row.nativeId).toBe(`${handle.id}-2`);
    await containers.shutdown();
  });
});

describe("a restart of a row another instance is removing", () => {
  it.each([
    ["with a new spec", CONTAINER_SPEC],
    ["with no spec", undefined],
  ])("is refused %s, leaving the claim as it was", async (_name, spec) => {
    const { containers, store } = fixture();
    const handle = await containers.start(CONTAINER_SPEC);
    await handle.close();
    const row = await store.get(handle.id);
    if (row === undefined) {
      throw new Error("expected a row");
    }
    const claimed = { ...row, holder: "another", status: "removing" } as const;
    await store.commit({ putContainers: [claimed] });

    await expect(containers.restart(handle.id, spec)).rejects.toThrow(
      "is being removed"
    );
    expect(await store.get(handle.id)).toEqual(claimed);
    await containers.shutdown();
  });
});

describe("managed service ids", () => {
  it("frees an id once its service is stopped", async () => {
    const { containers } = fixture();
    const { services } = await containers.start(CONTAINER_SPEC);
    if (!services) {
      throw new Error("expected services");
    }
    const input = {
      argv: ["serve"],
      id: "program",
      readiness: { kind: "started" },
      terminationGraceMs: 0,
    } as const;
    await services.start({ ...input, argv: ["serve"] });

    await services.stop("program");

    expect(await services.list()).toEqual([]);
    await expect(
      services.start({ ...input, argv: ["serve"] })
    ).resolves.toMatchObject({ id: "program" });
    await containers.shutdown();
  });

  it("frees an id whose service never became ready", async () => {
    const { containers } = fixture();
    const { services } = await containers.start(CONTAINER_SPEC);
    if (!services) {
      throw new Error("expected services");
    }
    await expect(
      services.start({
        argv: ["serve"],
        id: "program",
        readiness: { kind: "tcp", port: 9999, timeoutMs: 10 },
        terminationGraceMs: 0,
      })
    ).rejects.toThrow("is not exposed");

    expect(await services.list()).toEqual([]);
    await expect(
      services.start({
        argv: ["serve"],
        id: "program",
        readiness: { kind: "started" },
      })
    ).resolves.toMatchObject({ status: "ready" });
    await containers.shutdown();
  });
});
