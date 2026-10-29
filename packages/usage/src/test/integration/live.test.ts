import { describe, expect, it } from "vitest";

import { anthropic } from "../../providers/anthropic";
import { openai } from "../../providers/openai";
import { createUsage } from "../../usage";

/**
 * This machine's own default logins, read live: no fakes. A provider with no
 * signed-in login here is skipped. History covers a day, so it stays quick.
 */
const loginsOf = async (provider: typeof anthropic | typeof openai) =>
  (await provider.detect()).filter((credential) => credential.kind === "login");

const [claudeLogins, codexLogins] = await Promise.all([
  loginsOf(anthropic),
  loginsOf(openai),
]);

describe.each([
  {
    logins: claudeLogins,
    provider: anthropic,
    windows: ["five-hour-window", "weekly-window"],
  },
  { logins: codexLogins, provider: openai, windows: ["weekly-window"] },
])("$provider.id login", ({ logins, provider, windows }) => {
  it.skipIf(logins.length === 0)(
    "reads limits and a day of consumption",
    async () => {
      const usage = createUsage();
      usage.use(provider);
      const [login] = logins;
      const account = usage.add(login as NonNullable<typeof login>);
      const snapshot = await usage.query({ since: "1d" });
      const read = snapshot.of(account);

      expect(read?.failed).toBeUndefined();
      expect(read?.consumptionFailed).toBeUndefined();
      expect(read?.account?.id).toBeTruthy();
      for (const id of windows) {
        expect(read?.window(id)?.usedPercent).toBeGreaterThanOrEqual(0);
      }
      expect(read?.consumption?.since.getTime()).toBeLessThan(
        snapshot.at.getTime()
      );
    }
  );
});
