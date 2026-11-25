import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPAWN_OWNER_ENV,
  SPAWN_RECORD_ENV,
} from "@foundry/lib/node/spawn-record";
import { afterEach, expect, it, vi } from "vitest";
import { spawnStdioTransport } from "../../mcp/stdio";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("records the server it starts, and carries the recorder's variables to it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-record-"));
  vi.stubEnv(SPAWN_RECORD_ENV, dir);
  vi.stubEnv(SPAWN_OWNER_ENV, `owner ${dir}`);
  const said = join(dir, "said.json");
  const transport = spawnStdioTransport(
    {
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(said)}, JSON.stringify({ owner: process.env.${SPAWN_OWNER_ENV}, pid: process.pid, record: process.env.${SPAWN_RECORD_ENV} })); setInterval(() => undefined, 1000);`,
      ],
      command: process.execPath,
      kind: "stdio",
    },
    {}
  );
  await transport.start();
  try {
    await vi.waitFor(() => expect(existsSync(said)).toBe(true));
    const server = JSON.parse(readFileSync(said, "utf8"));
    expect(server).toEqual({
      owner: `owner ${dir}`,
      pid: server.pid,
      record: dir,
    });
    expect(readdirSync(dir)).toContain(`${String(server.pid)}.json`);
  } finally {
    await transport.close();
    rmSync(dir, { force: true, recursive: true });
  }
});
