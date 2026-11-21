import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "~/cli/args";
import { COMMANDS } from "~/cli/command-line";
import { applyTheme } from "~/cli/theme";
import { BUILT_IN_PALETTES } from "~/components/ui/theme";
import type { OpenedWorkspace } from "~/workspace/open";
import { temporaryDirectory } from "./helpers/temporary";

const shown = vi.hoisted(() => ({ backgrounds: [] as string[] }));

vi.mock("~/cli/status/view", async () => {
  const { theme } = await import("~/components/ui/theme");
  return {
    showStatus: () => {
      shown.backgrounds.push(theme.colors.background);
      return Promise.resolve();
    },
  };
});

const streams = [process.stdin, process.stdout] as const;
const saved = streams.map((stream) =>
  Object.getOwnPropertyDescriptor(stream, "isTTY")
);

function asTerminal(): void {
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  }
}

afterEach(() => {
  streams.forEach((stream, index) => {
    const descriptor = saved[index];
    if (descriptor === undefined) {
      Reflect.deleteProperty(stream, "isTTY");
    } else {
      Object.defineProperty(stream, "isTTY", descriptor);
    }
  });
  applyTheme("dark");
  shown.backgrounds.length = 0;
});

describe("the interactive status view", () => {
  test("opens in the saved theme", async () => {
    const state = temporaryDirectory("marbles-status-theme-");
    writeFileSync(
      join(state, "settings.json"),
      JSON.stringify({ theme: "light" })
    );
    const parsed = parseArgs(["status"]);
    if (parsed.command !== "status") {
      throw new Error("expected the status command");
    }
    const args = { ...parsed, state };
    const handler = COMMANDS.status;
    if (handler.needs !== "workspace") {
      throw new Error("expected status to need a workspace");
    }
    const opened = { workspace: { id: "ws1" } } as unknown as OpenedWorkspace;
    asTerminal();
    await handler.run(args, opened);
    expect(shown.backgrounds).toEqual([
      BUILT_IN_PALETTES.light.colors.background,
    ]);
    expect(BUILT_IN_PALETTES.light.colors.background).not.toBe(
      BUILT_IN_PALETTES.dark.colors.background
    );
  });
});
