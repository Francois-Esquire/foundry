#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import type { HarnessSession } from "@foundry/agents/harness";
import { HarnessActivities } from "~/lib/sandbox/activities";

/**
 * An engine generation whose workspace engines record one harness
 * activity, `activity` of session `session`, and, in the first generation
 * to start only (it leaves `MARBLES_TEST_STANDIN` behind as it does), hold
 * a stand-in session that can stop it: each stop is a line `stop <pid>`
 * in `MARBLES_TEST_STANDIN.log`. A later generation knows the activity
 * from the database, and holds no session to stop it with.
 */
const marker = process.env.MARBLES_TEST_STANDIN ?? "";
const { load } = HarnessActivities.prototype;
HarnessActivities.prototype.load = async function (this: HarnessActivities) {
  await load.call(this);
  if (marker === "" || existsSync(marker)) {
    return;
  }
  writeFileSync(marker, String(process.pid));
  const session = {
    capabilities: { interruption: true, steering: false },
    close: async () => undefined,
    generate() {
      throw new Error("unused");
    },
    interrupt: async () => undefined,
    route: { id: "test", provider: "test" },
    sessionId: "session",
    steer() {
      throw new Error("unused");
    },
    stopActivity: async () => {
      appendFileSync(`${marker}.log`, `stop ${String(process.pid)}\n`);
    },
    stream() {
      throw new Error("unused");
    },
  } as unknown as HarnessSession;
  this.attach("session", session);
  await this.record(
    {
      actions: ["stop"],
      agentId: "test",
      harness: "test",
      id: "activity",
      kind: "task",
      lifetime: "session",
      revision: 1,
      sessionId: "session",
      status: "running",
      title: "test",
    } as never,
    { definition: "hold1", path: ["hold1"], runId: "run" } as never
  );
};
await import("~/process/generation");
