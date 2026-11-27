import { beforeEach, describe, expect, it } from "vitest";
import { createContainers } from "../containers/containers";
import {
  CONTAINER_ENVIRONMENT_ID_LABEL,
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  CONTAINER_STORE_LABEL,
} from "../containers/defaults";
import { MemoryContainerStore } from "../store/memory";
import { createFakeDriver } from "../testing/index";
import {
  CONTAINER_SPEC,
  CONTAINER_STORES,
  fixture,
  newStore,
  useStore,
} from "./helpers/containers-fixture";

describe.each(CONTAINER_STORES)(
  "container ownership over %s",
  (_name, open) => {
    beforeEach(() => {
      useStore(open);
    });

    describe("sweep", () => {
      it("sweep stops VMs with our labels and no row, ignoring other instances and the harness", async () => {
        const runtime = createFakeDriver();
        const store = newStore();
        const other = createContainers({
          driver: runtime,
          instanceLabel: "instance-b",
          store: newStore(),
        });
        const mine = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store,
        });

        const kept = await mine.start(CONTAINER_SPEC);
        const orphan = await mine.start(CONTAINER_SPEC);
        await store.commit({ deleteContainers: [orphan.id] });
        const foreign = await other.start(CONTAINER_SPEC);
        const harnessLabels = {
          [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
          "com.foundry.environment.scope-id": "scope",
          [CONTAINER_ENVIRONMENT_ID_LABEL]: "harness-vm",
        };
        await runtime.create({
          containerId: "harness-vm",
          labels: harnessLabels,
          name: "harness-vm",
          spec: {
            cpus: 1,
            detached: false,
            env: {},
            expose: [],
            image: "x",
            labels: harnessLabels,
            memoryMib: 1,
            mounts: [],
            name: "harness-vm",
            network: "open",
            ports: [],
            pull: "missing",
            secrets: [],
            workdir: "/w",
          },
        });

        expect(await mine.sweep()).toEqual([`${orphan.id}-1`]);
        const byName = new Map(runtime.handles.map((i) => [i.id, i.removed]));
        expect(byName.get(`${kept.id}-1`)).toBe(false);
        expect(byName.get(`${orphan.id}-1`)).toBe(true);
        expect(byName.get(`${foreign.id}-1`)).toBe(false);
        expect(byName.get("harness-vm")).toBe(false);
        await kept.close();
        await foreign.close();
      });

      it("leaves, in a sweep, a VM with this instance's labels that no row's id labels", async () => {
        const { runtime, containers } = fixture();
        const unlabelledLabels = {
          [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
          [CONTAINER_INSTANCE_LABEL]: "instance-a",
        };
        const instance = await runtime.create({
          containerId: "unlabelled",
          labels: unlabelledLabels,
          name: "unlabelled",
          spec: {
            cpus: 1,
            detached: false,
            env: {},
            expose: [],
            image: "test-image",
            labels: unlabelledLabels,
            memoryMib: 512,
            mounts: [],
            name: "unlabelled",
            network: "none",
            ports: [],
            pull: "missing",
            secrets: [],
            workdir: "/work",
          },
        });
        expect(await containers.sweep()).toEqual([]);
        expect(runtime.handles.find((h) => h.id === instance.id)?.removed).toBe(
          false
        );
        await containers.shutdown();
      });

      it("sweeps only VMs that carry its own store's identity: another store's live VM, under the same instance label, is passed over and named", async () => {
        const runtime = createFakeDriver();
        const ours = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store: newStore(),
        });
        const theirs = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store: new MemoryContainerStore(),
        });
        const held = await theirs.start(CONTAINER_SPEC);
        const name = held.row.nativeId ?? "";
        const swept = await ours.sweep();
        expect([...swept]).toEqual([]);
        expect(swept.passedOver).toEqual([name]);
        expect(runtime.handles.find((i) => i.id === name)?.removed).toBe(false);
        const recovered = await ours.recover(() => true);
        expect(recovered.passedOver).toEqual([name]);
        await held.close();
        await theirs.shutdown();
        await ours.shutdown();
      });
    });

    describe("recovery", () => {
      it("recover removes the rows a gone process left, with their VMs, and sweeps VMs with no row, once", async () => {
        const runtime = createFakeDriver();
        const store = newStore();
        const gone = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store,
        });
        const running = await gone.start(CONTAINER_SPEC);
        const vanished = await gone.start(CONTAINER_SPEC);
        const unrowed = await gone.start(CONTAINER_SPEC);
        await runtime.stopResource(`${vanished.id}-1`);
        await runtime.removeResource(`${vanished.id}-1`);
        await store.commit({ deleteContainers: [unrowed.id] });

        const next = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store,
        });
        const mine = await next.start(CONTAINER_SPEC);
        const asked: string[] = [];
        const recovered = await next.recover((row) => {
          asked.push(row.id);
          return row.id !== mine.id;
        });

        expect(asked).toEqual([running.id, vanished.id]);
        expect(recovered).toEqual({
          conflicts: [],
          kept: [],
          passedOver: [],
          removed: [running.id, vanished.id],
          swept: [`${unrowed.id}-1`],
        });
        expect((await store.list()).map((row) => row.id)).toEqual([mine.id]);
        const byName = new Map(runtime.handles.map((i) => [i.id, i.removed]));
        expect(byName.get(`${running.id}-1`)).toBe(true);
        expect(byName.get(`${unrowed.id}-1`)).toBe(true);
        expect(byName.get(`${mine.id}-1`)).toBe(false);

        expect(await next.recover(() => true)).toEqual({
          conflicts: [],
          kept: [],
          passedOver: [],
          removed: [],
          swept: [],
        });
        expect((await store.list()).map((row) => row.id)).toEqual([mine.id]);
        await mine.close();
        await next.shutdown();
      });

      it("keeps the row of a VM a recovery could not remove, removing, and the next recovery takes it over and removes it", async () => {
        const runtime = createFakeDriver();
        const store = newStore();
        const gone = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const stop = runtime.stopResource.bind(runtime);
        const runtimeDown: { now: boolean } = { now: true };
        runtime.stopResource = async (name) => {
          if (runtimeDown.now) {
            throw new Error("runtime offline");
          }
          await stop(name);
        };

        const first = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store,
        });
        expect(await first.recover(() => true)).toEqual({
          conflicts: [],
          kept: [left.id],
          passedOver: [],
          removed: [],
          swept: [],
        });
        expect(await store.get(left.id)).toMatchObject({ status: "removing" });
        expect(runtime.handles[0]?.removed).toBe(false);

        runtimeDown.now = false;
        const second = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store,
        });
        expect(await second.recover(() => true)).toEqual({
          conflicts: [],
          kept: [],
          passedOver: [],
          removed: [left.id],
          swept: [],
        });
        expect(await store.list()).toEqual([]);
        expect(runtime.handles[0]?.removed).toBe(true);
        await second.shutdown();
      });

      it("leaves a row to the Containers that opened it while a recovery was judging it", async () => {
        const runtime = createFakeDriver();
        const store = newStore();
        const gone = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store,
        });
        const row = await gone.start(CONTAINER_SPEC);
        const recovering = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store,
        });
        const winner = createContainers({
          driver: runtime,
          instanceLabel: "instance-a",
          store,
        });
        let judged = (): void => undefined;
        let go = (): void => undefined;
        const asked = new Promise<void>((resolve) => {
          judged = resolve;
        });
        const proceed = new Promise<void>((resolve) => {
          go = resolve;
        });
        const recovery = recovering.recover(async () => {
          judged();
          await proceed;
          return true;
        });
        await asked;
        const opened = await winner.open(row.id);
        go();

        expect(await recovery).toEqual({
          conflicts: [],
          kept: [],
          passedOver: [],
          removed: [],
          swept: [],
        });
        const live = runtime.handles.at(-1);
        expect(live?.removed).toBe(false);
        expect(await store.get(row.id)).toMatchObject({ status: "running" });
        const holders: (string | undefined)[] = [];
        await recovering.recover((seen) => {
          holders.push(seen.holder);
          return false;
        });
        expect(holders).toEqual([opened.row.holder]);
        await opened.close();
        await winner.shutdown();
        await recovering.shutdown();
      });

      it.each(["created", "starting", "paused"] as const)(
        "sweeps an orphan in the %s runtime state",
        async (status) => {
          const { runtime, containers, store } = fixture();
          const id = globalThis.crypto.randomUUID();
          const own = await store.identity();
          try {
            const orphanLabels = {
              [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
              [CONTAINER_INSTANCE_LABEL]: "instance-a",
              [CONTAINER_ID_LABEL]: id,
              [CONTAINER_STORE_LABEL]: own,
            };
            const created = await runtime.create({
              containerId: id,
              labels: orphanLabels,
              name: `${id}-1`,
              spec: {
                cpus: 1,
                detached: false,
                env: {},
                expose: [],
                image: "test-image",
                labels: orphanLabels,
                memoryMib: 512,
                mounts: [],
                name: `${id}-1`,
                network: "none",
                ports: [],
                pull: "missing",
                secrets: [],
                workdir: "/work",
              },
            });
            const instance = runtime.handles.find((h) => h.id === created.id);
            if (instance === undefined) {
              throw new Error("expected created handle");
            }
            instance.nativeStatus = status;
            await expect(containers.sweep()).resolves.toEqual([instance.id]);
            expect(instance.removed).toBe(true);
            expect(instance.stopped).toBe(status !== "created");
          } finally {
            await containers.shutdown();
          }
        }
      );
    });
  }
);
