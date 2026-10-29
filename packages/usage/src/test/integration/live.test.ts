import { describe, expect, it } from "vitest";

import { anthropic } from "../../providers/anthropic";
import { openai } from "../../providers/openai";
import { createUsage } from "../../usage";

/**
 * This machine's own default accounts, read live: no fakes. A provider with
 * no signed-in default login here is skipped. History covers the default
 * day, so it stays quick.
 */
const usage = createUsage();
usage.use(anthropic);
usage.use(openai);
const names = await usage.initialize();

describe.each([
  { name: "anthropic", spans: ["hourly", "weekly"] as const },
  { name: "openai", spans: ["weekly"] as const },
])("the $name default account", ({ name, spans }) => {
  it.skipIf(!names.includes(name))(
    "reads resolved limits and a day of consumption",
    async () => {
      const snapshot = await usage.query(name);

      expect(snapshot.failed).toBeUndefined();
      expect(snapshot.consumptionFailed).toBeUndefined();
      expect(snapshot.identity?.id).toBeTruthy();
      for (const span of spans) {
        const found = snapshot[span];
        expect(found?.usedPercent).toBeGreaterThanOrEqual(0);
        expect(found?.headroom.share).toBeGreaterThanOrEqual(0);
        expect(typeof found?.exhausted).toBe("boolean");
      }
      expect(snapshot.consumption?.since.getTime()).toBeLessThan(
        snapshot.at.getTime()
      );
    }
  );
});
