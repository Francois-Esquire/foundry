import { afterEach, describe, expect, it } from "vitest";
import type { AutomationRecord } from "~/lib/automation/service";
import type { AutomationStore } from "~/lib/automation/store";

export interface AutomationStoreFixture {
  close(): Promise<void>;
  store(): AutomationStore;
}

export function automation(
  id: string,
  extra: Partial<AutomationRecord> = {}
): AutomationRecord {
  return {
    at: { hour: 9, weekday: ["mon", "fri"] },
    createdAt: "2026-11-01T09:00:00.000Z",
    enabled: true,
    id,
    input: null,
    key: id,
    owner: {
      agentId: "worker",
      sessionId: "session",
      source: { definition: "work", path: ["work", "plan"], runId: "rn-1" },
    },
    version: 1,
    workflow: "target",
    ...extra,
  };
}

export function describeAutomationStore(
  name: string,
  open: () => Promise<AutomationStoreFixture>,
  { shared }: { readonly shared: boolean }
): void {
  describe(name, () => {
    let fixture: AutomationStoreFixture | undefined;
    const made: AutomationStore[] = [];
    const store = async () => {
      fixture ??= await open();
      const automations = fixture.store();
      made.push(automations);
      return automations;
    };

    afterEach(async () => {
      for (const automations of made.splice(0)) {
        await automations.close().catch(() => undefined);
      }
      await fixture?.close();
      fixture = undefined;
    });

    it("keeps each automation whole by id, in id order, until it is removed", async () => {
      const automations = await store();
      const monitor = automation("b", {
        source: { glob: "*.md", kind: "files" },
      });
      const plain = automation("a", { at: "1h" });
      const { input: _input, ...noInput } = automation("c");
      await automations.put(monitor);
      await automations.put(plain);
      await automations.put(noInput);
      await automations.put({ ...plain, enabled: false });
      expect(await automations.list()).toEqual([
        { id: "a", value: { ...plain, enabled: false } },
        { id: "b", value: monitor },
        { id: "c", value: noInput },
      ]);
      await automations.remove("b");
      await automations.remove("never");
      expect((await automations.list()).map(({ id }) => id)).toEqual([
        "a",
        "c",
      ]);
    });

    it("keeps what an edit wrote once it resolves, and nothing of one that rejects", async () => {
      const automations = await store();
      await automations.put(automation("a"));
      await automations.edit(async (view) => {
        expect((await view.list()).map(({ id }) => id)).toEqual(["a"]);
        await view.put(automation("b"));
        await view.remove("a");
        expect((await view.list()).map(({ id }) => id)).toEqual(["b"]);
      });
      await expect(
        automations.edit(async (view) => {
          await view.put(automation("c"));
          throw new Error("changed its mind");
        })
      ).rejects.toThrow("changed its mind");
      expect((await automations.list()).map(({ id }) => id)).toEqual(["b"]);
    });

    it("owns a record from the call", async () => {
      const automations = await store();
      const record = automation("a") as { enabled: boolean };
      const putting = automations.put(record as unknown as AutomationRecord);
      record.enabled = false;
      await putting;
      expect((await automations.list())[0]?.value).toEqual(automation("a"));
    });

    it("keeps an automation as JSON gives it back, and refuses one JSON would not", async () => {
      const automations = await store();
      await automations.put(
        automation("a", {
          input: { gone: undefined, n: -0 } as unknown as Record<
            string,
            unknown
          >,
        })
      );
      const [kept] = await automations.list();
      expect(kept?.value).toStrictEqual(automation("a", { input: { n: 0 } }));
      await expect(
        automations.put(automation("b", { input: { n: Number.NaN } }))
      ).rejects.toThrow("NaN");
      await expect(
        automations.edit((view) =>
          view.put(automation("c", { input: { list: [undefined] } }))
        )
      ).rejects.toThrow("undefined");
      expect((await automations.list()).map(({ id }) => id)).toEqual(["a"]);
    });

    it.runIf(shared)(
      "lets one edit at a time read and write, across every store over the same state",
      async () => {
        const first = await store();
        const second = await store();
        const order: string[] = [];
        const editing = (label: string, over: AutomationStore) =>
          over.edit(async (view) => {
            order.push(`${label} reads ${String((await view.list()).length)}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
            await view.put(automation(label));
          });
        await Promise.all([editing("x", first), editing("y", second)]);
        expect(order.map((line) => line.at(-1)).toSorted()).toEqual(["0", "1"]);
        expect((await second.list()).map(({ id }) => id)).toEqual(["x", "y"]);
      }
    );

    it("refuses every call once closed", async () => {
      const automations = await store();
      await automations.close();
      await expect(automations.list()).rejects.toThrow();
      await expect(automations.put(automation("a"))).rejects.toThrow();
      await expect(automations.edit(() => Promise.resolve())).rejects.toThrow();
    });
  });
}
