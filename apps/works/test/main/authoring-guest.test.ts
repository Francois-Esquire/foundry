import { expect, it } from "vitest";
import {
  AUTHORING_GUEST_USER,
  authoringGuest,
} from "~/main/modules/authoring/guest";
import {
  collectWorkspace,
  seedWorkspace,
} from "~/main/modules/authoring/workspace";
import { fakeModuleSandboxes } from "../helpers/module-sandboxes";

const STAGED = /^\/tmp\/works-write-[0-9a-f-]{36}$/u;

async function sandbox() {
  const fake = fakeModuleSandboxes();
  const loan = await fake.sandboxes.borrow("module-a");
  const files = () => fake.runtime.instances.at(-1)?.files;
  return { ...fake, files, loan };
}

it("runs an authoring agent's commands, processes, reads and writes as the authoring user, never root", async () => {
  const { executions, files, loan, sandboxes } = await sandbox();
  const guest = authoringGuest(loan.container);
  executions.length = 0;

  await guest.commands.exec(["id"]);
  await guest.files.writeFile("/workspace/src/a.ts", "export {};");

  const [id, copy, cleanup] = executions;
  expect(id).toMatchObject({ command: ["id"], user: AUTHORING_GUEST_USER });
  // Staged at an unguessable name, then copied in by the authoring user, so
  // the write has only that user's permissions; root removes the stage.
  expect(copy).toMatchObject({ user: AUTHORING_GUEST_USER });
  const [staged, target] = copy?.command.slice(-2) ?? [];
  expect(staged).toMatch(STAGED);
  expect(target).toBe("/workspace/src/a.ts");
  expect(files()?.has(staged ?? "")).toBe(false);
  expect(cleanup).toMatchObject({ command: ["rm", "-f", "--", staged] });
  expect(cleanup?.user).toBeUndefined();
  // Reads run as the authoring user too, so root-only files stay closed.
  executions.length = 0;
  expect(new TextDecoder().decode(await guest.files.readFile("src/a.ts"))).toBe(
    "export {};"
  );
  expect(await guest.files.realpath("/workspace/src")).toBe("/workspace/src");
  expect(await guest.files.isDirectory("/workspace/src")).toBe(true);
  expect(await guest.files.list("/workspace", { recursive: true })).toEqual([
    { path: "/workspace/src", type: "directory" },
    { path: "/workspace/src/a.ts", type: "file" },
  ]);
  expect(executions.map(({ command, user }) => [command[0], user])).toEqual([
    ["base64", AUTHORING_GUEST_USER],
    ["realpath", AUTHORING_GUEST_USER],
    ["test", AUTHORING_GUEST_USER],
    ["find", AUTHORING_GUEST_USER],
  ]);
  await expect(guest.files.readFile("/builds/secret")).rejects.toThrow(
    "/builds/secret could not be read"
  );
  // Only what the agent was given: the rest of the container is refused.
  await expect(guest.files.copyOut("/builds")).rejects.toThrow(
    "Not available to an authoring agent"
  );
  await expect(guest.files.lstat("/builds")).rejects.toThrow(
    "Not available to an authoring agent"
  );
  await expect(guest.ports.hostPort(3000)).rejects.toThrow(
    "Not available to an authoring agent"
  );
  expect(guest.volumes).toBeUndefined();
  // No shell or service runs as root on the agent's behalf.
  await expect(guest.shell.open()).rejects.toThrow(
    "Not available to an authoring agent"
  );
  await expect(
    guest.services.start({ command: ["sh"], id: "x" } as never)
  ).rejects.toThrow("Not available to an authoring agent");
  loan.release();
  await sandboxes.shutdown();
});

it("ends the authoring user's processes before root seeds or collects the workspace, and hands it the seeded files", async () => {
  const { executions, loan, sandboxes } = await sandbox();
  const { signal } = new AbortController();
  executions.length = 0;

  await seedWorkspace(loan.container, { "src/a.ts": "a" }, signal);
  expect(executions.at(0)).toMatchObject({
    command: ["sh", "-c", "kill -9 -1 2>/dev/null; true"],
    user: AUTHORING_GUEST_USER,
  });
  expect(executions.at(-1)).toMatchObject({
    command: ["chown", "-R", "bun:bun", "/workspace"],
  });
  expect(executions.at(-1)?.user).toBeUndefined();

  executions.length = 0;
  await collectWorkspace(loan.container, { "src/a.ts": "a" }, signal);
  expect(executions.at(0)).toMatchObject({
    command: ["sh", "-c", "kill -9 -1 2>/dev/null; true"],
    user: AUTHORING_GUEST_USER,
  });
  loan.release();
  await sandboxes.shutdown();
});
