import { describe, expect, it } from "vitest";

import { anthropic } from "../../providers/anthropic";
import { openai } from "../../providers/openai";
import { createUsage } from "../../usage";

/**
 * This machine's own default accounts, read live: no fakes. A provider with
 * no signed-in default login here is skipped. History starts where the
 * weekly window did, as it does by default.
 */
const usage = createUsage();
usage.use(anthropic);
usage.use(openai);
const names = (await usage.initialize()).map((account) => account.name);

describe.each([
  { name: "anthropic", spans: ["hourly", "weekly"] as const },
  { name: "openai", spans: ["weekly"] as const },
])("the $name default account", ({ name, spans }) => {
  it.skipIf(!names.includes(name))(
    "reads resolved limits and consumption since the weekly window started",
    async () => {
      const snapshot = await usage.query(name);

      expect(snapshot.failed).toBeUndefined();
      expect(snapshot.consumptionFailed).toBeUndefined();
      expect(snapshot.identity?.id).toBeTruthy();
      for (const span of spans) {
        const found = snapshot[span];
        expect(snapshot.limits).toContain(found);
        expect(found?.usedPercent).toBeGreaterThanOrEqual(0);
        expect(found?.headroom.share).toBeGreaterThanOrEqual(0);
        expect(typeof found?.exhausted).toBe("boolean");
      }
      const { weekly } = snapshot;
      expect(snapshot.consumption?.since).toEqual(
        weekly?.resetsAt
          ? new Date(weekly.resetsAt.getTime() - weekly.duration)
          : new Date(snapshot.at.getTime() - 7 * 24 * 3_600_000)
      );
    }
  );
});
