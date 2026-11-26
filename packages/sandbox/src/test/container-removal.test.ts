import { beforeEach, describe, expect, it } from "vitest";
import { createContainers } from "../container/containers";
import {
  CONTAINER_ID_LABEL,
  CONTAINER_INSTANCE_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  CONTAINER_STORE_LABEL,
} from "../container/defaults";
import { createFakeContainerRuntime } from "../testing/index";
import {
  CONTAINER_SPEC,
  CONTAINER_STORES,
  newStore,
  useStore,
} from "./helpers/containers-fixture";

describe.each(CONTAINER_STORES)(
  "container ownership over %s",
  (_name, open) => {
    beforeEach(() => {
      useStore(open);
    });

    describe("removal and conflicts", () => {
      it("removes every VM of a row it deletes, so a start cut short after the delete leaves none for the next to miss", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const row = await store.get(left.id);
        if (row === undefined) {
          throw new Error("no row");
        }
        await store.commit({
          putContainers: [
            { ...row, nativeId: `${left.id}-2`, status: "starting" },
          ],
        });

        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const dies = new AbortController();
        await expect(
          next.recover(() => {
            dies.abort();
            return true;
          }, dies.signal)
        ).rejects.toThrow("cancelled");

        expect(await store.list()).toEqual([]);
        expect(
          runtime.instances.find((i) => i.id === `${left.id}-1`)?.removed
        ).toBe(true);
        await next.shutdown();
      });

      it("remove deletes a row only with every VM labelled with its id", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const row = await store.get(left.id);
        if (row === undefined) {
          throw new Error("no row");
        }
        await store.commit({
          putContainers: [
            { ...row, nativeId: `${left.id}-2`, status: "starting" },
          ],
        });
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });

        await runtime.stopResource(`${left.id}-1`);
        const stop = runtime.stopResource.bind(runtime);
        runtime.stopResource = (name) =>
          name === `${left.id}-1`
            ? Promise.reject(new Error("already stopped"))
            : stop(name);

        await next.remove(left.id);

        expect(await store.list()).toEqual([]);
        expect(
          runtime.instances.find((i) => i.id === `${left.id}-1`)?.removed
        ).toBe(true);
        await next.shutdown();
      });

      it("never removes a VM another row records, whatever its label says: the row is kept, removing, and the conflict named", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const other = await gone.start(CONTAINER_SPEC);
        const vm = `${left.id}-1`;
        const leftRow = await store.get(left.id);
        const otherRow = await store.get(other.id);
        if (leftRow === undefined || otherRow === undefined) {
          throw new Error("no rows");
        }
        await store.commit({
          putContainers: [
            { ...leftRow, nativeId: `${left.id}-2` },
            { ...otherRow, holder: "alive", nativeId: vm, status: "running" },
          ],
        });

        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const recovered = await next.recover((row) => row.id === left.id);

        expect(recovered).toEqual({
          conflicts: [vm],
          kept: [left.id],
          passedOver: [],
          removed: [],
          swept: [],
        });
        const instance = runtime.instances.find((i) => i.id === vm);
        expect(instance?.removed).toBe(false);
        expect(instance?.stopped).toBe(false);
        expect(await store.get(left.id)).toMatchObject({ status: "removing" });
        expect(await store.get(other.id)).toMatchObject({
          nativeId: vm,
          status: "running",
        });
        await expect(next.remove(left.id)).rejects.toThrow(vm);

        await store.commit({ deleteContainers: [left.id] });
        expect((await next.sweep()).swept).not.toContain(vm);
        expect(instance?.removed).toBe(false);
        await next.shutdown();
      });

      it("asks afresh, right before each VM it removes, whether another row records it", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const other = await gone.start(CONTAINER_SPEC);
        const row = await store.get(left.id);
        const otherRow = await store.get(other.id);
        if (row === undefined || otherRow === undefined) {
          throw new Error("no rows");
        }
        await store.commit({
          putContainers: [
            { ...row, nativeId: `${left.id}-2`, status: "starting" },
          ],
        });
        await runtime.create({
          cpus: 1,
          detached: false,
          disableNetwork: false,
          env: {},
          image: "x",
          labels: {
            [CONTAINER_MANAGED_BY_LABEL]: CONTAINER_MANAGED_BY_VALUE,
            [CONTAINER_INSTANCE_LABEL]: "instance-a",
            [CONTAINER_ID_LABEL]: left.id,
          },
          memoryMib: 1,
          mounts: [],
          name: `${left.id}-2`,
          ports: [],
          pull: "missing",
          workdir: "/w",
        });
        const names = [`${left.id}-1`, `${left.id}-2`];
        const stop = runtime.stopResource.bind(runtime);
        let claimed: string | undefined;
        runtime.stopResource = async (name) => {
          if (claimed === undefined && names.includes(name)) {
            claimed = names.find((each) => each !== name);
            await store.commit({
              putContainers: [
                {
                  ...otherRow,
                  holder: "alive",
                  nativeId: claimed,
                  status: "running",
                },
              ],
            });
          }
          await stop(name);
        };
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });

        const recovered = await next.recover((each) => each.id === left.id);

        expect(recovered).toMatchObject({
          conflicts: [claimed],
          kept: [left.id],
          passedOver: [claimed],
          removed: [],
        });
        const instance = runtime.instances.find((i) => i.id === claimed);
        expect(instance?.removed).toBe(false);
        expect(instance?.stopped).toBe(false);
        await next.shutdown();
      });

      it("never acts on a VM whose name is not its labelled row's own, nor writes a row recording another's", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const other = await gone.start(CONTAINER_SPEC);
        const list = runtime.listResources.bind(runtime);
        runtime.listResources = async (query) => {
          const listed = await list(query);
          return {
            ...listed,
            resources: listed.resources.map((resource) =>
              resource.name === `${other.id}-1`
                ? {
                    ...resource,
                    labels: {
                      ...resource.labels,
                      [CONTAINER_ID_LABEL]: left.id,
                    },
                  }
                : resource
            ),
          };
        };
        await store.commit({ deleteContainers: [other.id] });
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const recovered = await next.recover((each) => each.id === left.id);
        expect(recovered).toMatchObject({
          conflicts: [`${other.id}-1`],
          kept: [left.id],
        });
        expect((await next.sweep()).swept).not.toContain(`${other.id}-1`);
        const instance = runtime.instances.find(
          (i) => i.id === `${other.id}-1`
        );
        expect(instance?.removed).toBe(false);

        const row = await store.get(left.id);
        if (row === undefined) {
          throw new Error("no row");
        }
        await store.commit({
          putContainers: [
            { ...row, nativeId: `${other.id}-1`, status: "stopped" },
          ],
        });
        await expect(next.restart(left.id, CONTAINER_SPEC)).rejects.toThrow(
          "records the native name"
        );
        await next.shutdown();
      });

      it("never removes a VM named as a row's own but labelled with another row's id: a conflict, left", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const other = await gone.start(CONTAINER_SPEC);
        const list = runtime.listResources.bind(runtime);
        runtime.listResources = async (query) => {
          const listed = await list(query);
          return {
            ...listed,
            resources: listed.resources.map((resource) =>
              resource.name === `${left.id}-1`
                ? {
                    ...resource,
                    labels: {
                      ...resource.labels,
                      [CONTAINER_ID_LABEL]: other.id,
                    },
                  }
                : resource
            ),
          };
        };
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        expect(await next.recover((each) => each.id === left.id)).toMatchObject(
          {
            conflicts: [`${left.id}-1`],
            kept: [left.id],
            passedOver: [`${left.id}-1`],
            removed: [],
          }
        );
        const instance = runtime.instances.find((i) => i.id === `${left.id}-1`);
        expect(instance?.removed).toBe(false);
        expect(instance?.stopped).toBe(false);
        await next.shutdown();
      });

      it("never abandons, nor reclaims, a previous VM that is not the reopened row's own", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const holder = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const held = await holder.start(CONTAINER_SPEC);
        const heldName = held.row.nativeId ?? "";
        const stray = "33333333-3333-4333-8333-333333333333";
        await store.commit({
          putContainers: [
            {
              createdAt: 1,
              holder: "dead",
              id: stray,
              nativeId: heldName,
              spec: JSON.stringify(CONTAINER_SPEC),
              status: "running",
              updatedAt: 1,
            },
          ],
        });
        const stop = runtime.stopResource.bind(runtime);
        let failed = false;
        runtime.stopResource = (name) => {
          if (!failed && name === heldName) {
            failed = true;
            return Promise.reject(new Error("transient"));
          }
          return stop(name);
        };
        const next = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const reopened = await next.open(stray);
        await next.sweep();
        await next.shutdown().catch(() => undefined);
        const instance = runtime.instances.find((i) => i.id === heldName);
        expect(instance?.removed).toBe(false);
        expect(instance?.stopped).toBe(false);
        expect(await store.get(held.id)).toMatchObject({ status: "running" });
        await reopened.close().catch(() => undefined);
        await held.close();
        await holder.shutdown();
      });
    });

    describe("reporting", () => {
      it("keeps the old VM of a reopened row to retry, and says so, when the inventory cannot be read", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const lines: string[] = [];
        const next = createContainers({
          instanceLabel: "instance-a",
          report: (line) => lines.push(line),
          runtime,
          store,
        });
        const list = runtime.listResources.bind(runtime);
        let failing = true;
        runtime.listResources = (query) => {
          if (failing) {
            failing = false;
            return Promise.reject(new Error("inventory down"));
          }
          return list(query);
        };
        const reopened = await next.open(left.id);
        expect(lines).toEqual([expect.stringContaining(`${left.id}-1`)]);
        const old = runtime.instances.find((i) => i.id === `${left.id}-1`);
        expect(old?.removed).toBe(false);
        expect((await next.sweep()).swept).toEqual([`${left.id}-1`]);
        expect(old?.removed).toBe(true);
        await reopened.close();
        await next.shutdown();
      });

      it("goes on, and boots, when its reporter throws", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const next = createContainers({
          instanceLabel: "instance-a",
          report: () => {
            throw new Error("the reporter broke");
          },
          runtime,
          store,
        });
        const list = runtime.listResources.bind(runtime);
        let failing = true;
        runtime.listResources = (query) => {
          if (failing) {
            failing = false;
            return Promise.reject(new Error("inventory down"));
          }
          return list(query);
        };
        const reopened = await next.open(left.id);
        expect(await store.get(left.id)).toMatchObject({
          nativeId: `${left.id}-2`,
          status: "running",
        });
        expect((await next.sweep()).swept).toEqual([`${left.id}-1`]);
        await reopened.close();
        await next.shutdown();
      });

      it("names, in what it reports, a way to remove a running VM by hand", async () => {
        const runtime = createFakeContainerRuntime();
        const store = newStore();
        const gone = createContainers({
          instanceLabel: "instance-a",
          runtime,
          store,
        });
        const left = await gone.start(CONTAINER_SPEC);
        const list = runtime.listResources.bind(runtime);
        runtime.listResources = async (query) => {
          const listed = await list(query);
          return {
            ...listed,
            resources: listed.resources.map((resource) => ({
              ...resource,
              labels: {
                ...resource.labels,
                [CONTAINER_STORE_LABEL]: "another",
              },
            })),
          };
        };
        const lines: string[] = [];
        const next = createContainers({
          instanceLabel: "instance-a",
          report: (line) => lines.push(line),
          runtime,
          store,
        });
        const reopened = await next.open(left.id);
        expect(lines).toEqual([
          expect.stringContaining(`msb rm -f ${left.id}-1`),
        ]);
        expect(lines[0]).toContain("node_modules/.bin/msb");
        await reopened.close();
        await next.shutdown();
      });
    });
  }
);
