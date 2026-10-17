import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryArtifactStore } from "@foundry/artifacts";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModuleLibrary } from "~/main/modules/library";
import { ModuleSessions } from "~/main/modules/runtime/controller";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import { WORKS_TASKS } from "~/shared/execution";
import { startTestExecution } from "../helpers/execution";
import { installedProcess } from "../helpers/installed-programs";
import { moduleReleasePackage } from "../helpers/module-release";
import { unrecordedSaves } from "../helpers/source-saves";
import { DISK_TEST_TIMEOUT_MS } from "../helpers/timeouts";

const APP_SCHEME = "module-app://";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "works-network-"));
  directories.push(directory);
  const execution = await startTestExecution();
  const works = installedProcess(
    new JsonArtifactStore({ path: path.join(directory, "artifacts.json") }),
    execution,
    directory
  );
  const module = await works.library.create("Networked");
  return { execution, module, works };
}

const network = (...hosts: string[]) => ({
  network: {
    destinations: hosts.map((host) => ({ host })),
    reason: "Loads forecasts",
  },
});
const allowlist = (...hosts: string[]) => hosts.map((host) => ({ host }));

describe("Released app network follows the Installation's network Grant", () => {
  it("gives a Program exactly the approved destinations and nothing otherwise", {
    timeout: DISK_TEST_TIMEOUT_MS,
  }, async () => {
    const { module, works } = await setup();
    const open = async (version: Parameters<typeof works.runtime.start>[0]) =>
      await (
        await works.runtime.start(version, new AbortController().signal)
      ).close();

    // Undeclared.
    await open(await works.release(module.id, "0.1.0", {}));
    // Declared, not approved.
    const declared = await works.release(
      module.id,
      "0.2.0",
      network("api.example.com")
    );
    await open(declared);
    // Approved.
    await works.access.approve(module.id, "network");
    await open(declared);
    // Revoked.
    await works.access.revoke(module.id, "network");
    await open(declared);
    // Approved, then the declaration changes: no access, Access asks again.
    await works.access.approve(module.id, "network");
    const changed = await works.release(
      module.id,
      "0.3.0",
      network("api.example.com", "api.example.org")
    );
    await open(changed);

    expect(works.networks).toEqual([
      null,
      null,
      allowlist("api.example.com"),
      null,
      null,
    ]);
    const view = await works.access.get(module.id);
    expect(view.version?.tag).toBe("0.3.0");
    expect(view.scope.network).toEqual([]);
    expect(
      view.requests.find((request) => request.kind === "network")
    ).toMatchObject({ approved: false, availability: "available" });
  });

  it("stops the running Program before a revoke is reported and restarts it without network", async () => {
    const { execution, module, works } = await setup();
    const version = await works.release(
      module.id,
      "0.1.0",
      network("api.example.com")
    );
    await works.access.approve(module.id, "network");
    const watch = works.sessions.watch(module.id, version.contentId);
    const first = await watch.next();
    expect(works.networks).toEqual([allowlist("api.example.com")]);

    const order: string[] = [];
    works.stopped.mockImplementation(() => {
      order.push("stopped");
      return Promise.resolve();
    });
    // Nothing pulls the app's next session while the revoke runs.
    await works.access.revoke(module.id, "network");
    order.push("revoked");

    expect(order).toEqual(["stopped", "revoked"]);
    expect(works.networks).toEqual([allowlist("api.example.com"), null]);
    expect(
      (await works.modules.loadGatewayContext(moduleInstallationId(module.id)))
        ?.installation.status
    ).toBe("active");
    const second = await watch.next();
    expect(second.value?.origin).not.toBe(first.value?.origin);

    const runs = execution.runs.list();
    const programs = runs.filter((run) => run.name === WORKS_TASKS.program);
    expect(programs.map((run) => run.status)).toEqual(["complete", "running"]);
    expect(
      runs.filter((run) => run.name === WORKS_TASKS.access).at(-1)
    ).toMatchObject({
      observations: [
        {
          data: { action: "revoke", capability: "network", restarted: 1 },
          type: "access",
        },
      ],
      queue: "system",
      status: "complete",
    });
    await watch.return();
  });

  it("restarts a running Program with the destinations it was just approved", async () => {
    const { module, works } = await setup();
    const version = await works.release(
      module.id,
      "0.1.0",
      network("api.example.com")
    );
    const watch = works.sessions.watch(module.id, version.contentId);
    await watch.next();
    await works.access.approve(module.id, "network");
    expect(works.networks).toEqual([null, allowlist("api.example.com")]);
    await watch.return();
  });

  it("refuses to report a revoke complete when the running Program did not stop", async () => {
    const { module, works } = await setup();
    const version = await works.release(
      module.id,
      "0.1.0",
      network("api.example.com")
    );
    await works.access.approve(module.id, "network");
    const watch = works.sessions.watch(module.id, version.contentId);
    await watch.next();
    works.stopped.mockRejectedValueOnce(new Error("VM stuck"));

    await expect(works.access.revoke(module.id, "network")).rejects.toThrow(
      "Network access was revoked, but the running app did not stop"
    );
    // The Grant itself is gone; nothing new starts under it.
    expect(
      (await works.modules.loadGatewayContext(moduleInstallationId(module.id)))
        ?.grants
    ).toEqual([]);
    expect(works.networks).toHaveLength(1);
    await watch.return().catch(() => undefined);
  });

  it("starts nothing on approval when the Module has no open app", async () => {
    const { module, works } = await setup();
    await works.release(module.id, "0.1.0", network("api.example.com"));
    const restart = vi.spyOn(works.sessions, "restart");
    await works.access.approve(module.id, "network");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(works.networks).toEqual([]);
  });
});

describe("Module session restart", () => {
  async function gatedSessions() {
    const library = createModuleLibrary(new InMemoryArtifactStore(), {
      saves: unrecordedSaves,
    });
    const { encoded } = await moduleReleasePackage();
    const imported = await library.importPackage(encoded);
    const release = (await library.details(imported.id))?.releases[0];
    if (!release) {
      throw new Error("Imported release missing");
    }
    const gates: PromiseWithResolvers<void>[] = [];
    const close = vi.fn(async () => undefined);
    const start = vi.fn(async () => {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      await gate.promise;
      return { close, origin: `http://127.0.0.1:${3000 + gates.length}` };
    });
    return {
      close,
      contentId: release.contentId,
      gates,
      id: imported.id,
      sessions: new ModuleSessions({
        execution: await startTestExecution(),
        library,
        runtime: {
          revoked: () => undefined,
          shutdown: async () => undefined,
          start,
        },
      }),
      start,
    };
  }

  it("replaces a Program whose start was under way when the restart was asked", async () => {
    const { close, contentId, gates, id, sessions, start } =
      await gatedSessions();
    const watch = sessions.watch(id, contentId);
    const first = watch.next();
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    // This start may have read the old authority.
    const restarted = sessions.restart(id);
    gates[0]?.resolve();
    await first;
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(close).toHaveBeenCalledTimes(1);
    gates[1]?.resolve();
    await expect(restarted).resolves.toBe(1);
    expect(start).toHaveBeenCalledTimes(2);

    const next = await watch.next();
    const token = next.value?.origin.replace(APP_SCHEME, "") ?? "";
    expect(sessions.endpoint(token)).toEqual(
      expect.objectContaining({ origin: "http://127.0.0.1:3002" })
    );
    await watch.return();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("tells an app that is watching that its Program is restarting, then hands on the new one", async () => {
    const { close, contentId, gates, id, sessions } = await gatedSessions();
    const watch = sessions.watch(id, contentId);
    const first = watch.next();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]?.resolve();
    const shown = (await first).value;
    expect(shown?.restarting).toBeUndefined();

    const pending = watch.next();
    const restarted = sessions.restart(id);
    // The gap: the old Program stops before the new one is up.
    expect((await pending).value).toEqual({
      origin: shown?.origin,
      restarting: true,
      views: shown?.views,
    });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(close).toHaveBeenCalledTimes(1);
    const next = watch.next();
    gates[1]?.resolve();
    await expect(restarted).resolves.toBe(1);
    const replaced = (await next).value;
    expect(replaced?.restarting).toBeUndefined();
    expect(replaced?.origin).not.toBe(shown?.origin);
    await watch.return();
  });

  it("restarts nothing when no app of the Module is open", async () => {
    const { id, sessions, start } = await gatedSessions();
    await expect(sessions.restart(id)).resolves.toBe(0);
    expect(start).not.toHaveBeenCalled();
  });
});
