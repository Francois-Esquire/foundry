import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import { SandboxCapacity } from "~/main/modules/sandboxes/capacity";
import { WORKS_TASKS } from "~/shared/execution";
import { startTestExecution } from "../helpers/execution";
import { installedProcess } from "../helpers/installed-programs";
import { weatherProvider } from "../helpers/weather-provider";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function setup(
  providers = [weatherProvider()],
  options: Parameters<typeof installedProcess>[4] = {}
) {
  const directory = await mkdtemp(path.join(tmpdir(), "works-installed-"));
  directories.push(directory);
  const file = path.join(directory, "artifacts.json");
  const execution = await startTestExecution();
  /** A Works process over the library file; a second call is a restart. */
  const restart = () =>
    installedProcess(
      new JsonArtifactStore({ path: file }),
      execution,
      directory,
      providers,
      options
    );
  const first = restart();
  const module = await first.library.create("Installed");
  return { execution, first, module, restart };
}

const weather = (city: string, required = true) => ({
  capabilities: [
    {
      alias: "weather",
      capability: "host.weather.read",
      constraints: { city },
      reason: "Shows the forecast",
      required,
      version: 1,
    },
  ],
});
const network = (host: string) => ({
  network: { destinations: [{ host }], reason: "Loads forecasts" },
});

async function open(
  process: ReturnType<typeof installedProcess>,
  version: Parameters<
    ReturnType<typeof installedProcess>["runtime"]["start"]
  >[0]
) {
  return await process.runtime.start(version, new AbortController().signal);
}

describe("Works released Programs on one durable Installation", () => {
  it("keeps one Installation and its Grants across close, reopen and restart", async () => {
    const { first, module, restart } = await setup();
    const version = await first.release(module.id, "0.1.0", weather("Oslo"));
    await first.access.approve(module.id, "host.weather.read");
    const id = moduleInstallationId(module.id);

    const app = await open(first, version);
    expect(app.origin).toBe("http://program.test");
    expect(
      (await first.modules.loadGatewayContext(id))?.installation.status
    ).toBe("active");
    await app.close();
    const closed = await first.modules.loadGatewayContext(id);
    expect(closed?.installation).toMatchObject({
      contentId: version.contentId,
      status: "disabled",
    });
    await (await open(first, version)).close();

    const second = restart();
    const reopened = await second.modules.loadGatewayContext(id);
    expect(reopened?.grants.map((grant) => grant.capability)).toEqual([
      "host.weather.read",
    ]);
    expect(reopened?.installation.generation).toBeGreaterThan(
      closed?.installation.generation ?? 0
    );
    expect((await second.modules.listInstallations()).items).toHaveLength(1);
    await (await open(second, version)).close();
    expect((await second.modules.listInstallations()).items).toHaveLength(1);
  });

  it("reconciles a Program a dead process left active before starting it again", async () => {
    const { first, module, restart } = await setup([]);
    const version = await first.release(module.id, "0.1.0", {});
    await open(first, version);
    const id = moduleInstallationId(module.id);
    const crashed = await first.modules.loadGatewayContext(id);
    expect(crashed?.installation.status).toBe("active");
    const crashedRuntime = await first.programs.active(id);

    // A new process: the persisted `active` is not a live Program.
    const second = restart();
    await vi.waitFor(async () => {
      expect(
        (await second.modules.loadGatewayContext(id))?.installation.status
      ).toBe("disabled");
    });
    const reconciled = await second.modules.loadGatewayContext(id);
    expect(reconciled?.installation.generation).toBeGreaterThan(
      crashedRuntime?.generation ?? 0
    );
    const app = await open(second, version);
    const live = await second.programs.active(id);
    expect(live?.generation).toBeGreaterThan(
      reconciled?.installation.generation ?? 0
    );
    await app.close();
  });

  it("starts and stops without staling the source binding", async () => {
    const { first, module } = await setup([]);
    const version = await first.release(module.id, "0.1.0", {});
    const details = await first.library.details(module.id);
    if (!details?.binding) {
      throw new Error("Binding missing");
    }
    const listed = async () =>
      (await first.library.list()).find((summary) => summary.id === module.id)
        ?.updatedAt;
    const updated = await listed();
    await (await open(first, version)).close();
    await (await open(first, version)).close();
    // The Catalog's "Updated" is source time: opening the app moves nothing.
    expect(await listed()).toBe(updated);
    // Installation transitions patch Artifact metadata, not the Content the
    // binding fences on.
    expect((await first.library.details(module.id))?.binding).toEqual(
      details.binding
    );
    await expect(
      first.library.saveSource(
        module.id,
        { ...details.source, "notes.md": "edited while installed" },
        details.binding
      )
    ).resolves.toMatchObject({ artifactId: details.binding.artifactId });
  });

  it("carries matching Grants to another Version and asks again for changed ones", async () => {
    const { first, module } = await setup();
    const id = moduleInstallationId(module.id);
    const v1 = await first.release(module.id, "0.1.0", {
      ...weather("Oslo"),
      ...network("api.example.com"),
    });
    await first.access.approve(module.id, "host.weather.read");
    await first.access.approve(module.id, "network");
    expect((await first.access.get(module.id)).scope.network).toEqual([
      "api.example.com",
    ]);
    await (await open(first, v1)).close();

    // Same weather request, new destinations: weather carries over, network asks again.
    const v2 = await first.release(module.id, "0.2.0", {
      ...weather("Oslo"),
      ...network("other.example.com"),
    });
    await (await open(first, v2)).close();
    const afterV2 = await first.access.get(module.id);
    expect(afterV2.version?.tag).toBe("0.2.0");
    expect(
      afterV2.requests.map(({ capability, approved }) => [capability, approved])
    ).toEqual([
      ["host.weather.read", true],
      ["network", false],
    ]);
    expect(afterV2.scope.network).toEqual([]);
    expect(
      (await first.modules.loadGatewayContext(id))?.grants.map(
        (grant) => grant.capability
      )
    ).toEqual(["host.weather.read"]);

    // A changed required constraint asks again, and blocks the start until approved.
    const v3 = await first.release(module.id, "0.3.0", weather("Bergen"));
    await expect(open(first, v3)).rejects.toThrow(
      "Approve it in the Module's Access panel"
    );
    const blocked = await first.access.get(module.id);
    expect(blocked.version?.tag).toBe("0.3.0");
    expect(blocked.requests[0]).toMatchObject({
      approved: false,
      capability: "host.weather.read",
      required: true,
    });
    expect(
      (await first.modules.loadGatewayContext(id))?.installation.status
    ).toBe("disabled");
    await first.access.approve(module.id, "host.weather.read");
    await (await open(first, v3)).close();
  });

  it("revokes through a system run: active Invocations are cancelled and new ones refused", async () => {
    const providerSignals: AbortSignal[] = [];
    const provider = weatherProvider(
      (_input, context) =>
        new Promise((resolve) => {
          providerSignals.push(context.signal);
          context.signal.addEventListener("abort", () => resolve({}), {
            once: true,
          });
        })
    );
    const { execution, first, module } = await setup([provider]);
    const version = await first.release(module.id, "0.1.0", weather("Oslo"));
    await first.access.approve(module.id, "host.weather.read");
    const app = await open(first, version);
    const runtime = await first.programs.active(
      moduleInstallationId(module.id)
    );
    if (!runtime) {
      throw new Error("Program not active");
    }
    const invoke = (id: string) =>
      first.invocations.dispatch({
        capabilities: version.manifest.capabilities,
        request: {
          alias: "weather",
          id,
          input: {},
          kind: "invoke",
          mode: "unary",
        },
        runtime,
        signal: new AbortController().signal,
      });
    const active = invoke("request-1").then(
      () => null,
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(providerSignals).toHaveLength(1));

    const view = await first.access.revoke(module.id, "host.weather.read");
    expect(view.requests).toMatchObject([{ approved: false }]);
    expect(providerSignals[0]?.aborted).toBe(true);
    expect(await active).toMatchObject({ code: "cancelled" });
    await expect(invoke("request-2")).rejects.toMatchObject({
      code: "unauthorized",
    });
    await app.close();

    const runs = execution.runs
      .list()
      .filter((run) => run.name === WORKS_TASKS.access);
    expect(runs.map((run) => [run.status, run.correlation.moduleId])).toEqual([
      ["complete", module.id],
      ["complete", module.id],
    ]);
    expect(runs.at(-1)?.observations).toMatchObject([
      {
        data: { action: "revoke", capability: "host.weather.read" },
        type: "access",
      },
    ]);
  });

  it("reports in Access whether the app's own files outlive a stop", async () => {
    const { first, module } = await setup([]);
    expect((await first.access.get(module.id)).privateFiles).toBeNull();
    await first.release(module.id, "0.1.0", {});
    expect((await first.access.get(module.id)).privateFiles).toBe(
      "installation"
    );
    await first.release(module.id, "0.2.0", {
      data: undefined,
      persistence: { files: "none" },
    });
    expect((await first.access.get(module.id)).privateFiles).toBe("none");
  });

  it("refuses approval for something the Version does not request or the host cannot provide", async () => {
    const { first, module } = await setup([]);
    await expect(first.access.approve(module.id, "network")).rejects.toThrow(
      "Build a release before approving access"
    );
    await first.release(module.id, "0.1.0", network("api.example.com"));
    await expect(
      first.access.approve(module.id, "host.weather.read")
    ).rejects.toThrow("does not request host.weather.read");
    await expect(first.access.revoke(module.id, "network")).rejects.toThrow(
      "network is not approved"
    );
    const view = await first.access.approve(module.id, "network");
    expect(view).toMatchObject({
      installation: { status: "disabled" },
      requests: [{ approved: true, kind: "network", required: false }],
      scope: {
        artifacts: [],
        network: ["api.example.com"],
        workflows: [],
      },
    });
  });

  it("keeps a Program's capacity and slot until a failed stop is confirmed on retry", async () => {
    // One sandbox on the machine: whatever holds it shows in a probe.
    const capacity = new SandboxCapacity({
      memoryBytes: Number.MAX_SAFE_INTEGER,
      sandboxes: 1,
    });
    const { first, module } = await setup([], { capacity });
    const version = await first.release(module.id, "0.1.0", {});
    const id = moduleInstallationId(module.id);
    const app = await open(first, version);

    first.stopped.mockRejectedValueOnce(new Error("VM did not stop"));
    await expect(app.close()).rejects.toThrow();
    expect(first.stopped).toHaveBeenCalledOnce();

    // The VM may still be live: another sandbox cannot take its share.
    const waiting = vi.fn();
    const probe = new AbortController();
    const blocked = capacity.acquire(1, { signal: probe.signal, waiting });
    expect(waiting).toHaveBeenCalledOnce();
    probe.abort();
    await expect(blocked).rejects.toMatchObject({ name: "AbortError" });

    // The next start drives the stop again before it starts anything.
    const reopened = await open(first, version);
    expect(first.stopped).toHaveBeenCalledTimes(2);
    expect((await first.programs.active(id))?.runtimeInstanceId).toBe(
      "runtime-2"
    );
    await reopened.close();
    expect(first.stopped).toHaveBeenCalledTimes(3);
    const freed = await capacity.acquire(1);
    freed.release();
  });

  it("fails a waiting start truthfully while the previous Program still cannot stop", async () => {
    const capacity = new SandboxCapacity({
      memoryBytes: Number.MAX_SAFE_INTEGER,
      sandboxes: 1,
    });
    const { first, module } = await setup([], { capacity });
    const version = await first.release(module.id, "0.1.0", {});
    const app = await open(first, version);
    const stop = Promise.withResolvers<void>();
    first.stopped.mockReturnValueOnce(stop.promise);
    first.stopped.mockRejectedValueOnce(new Error("VM still running"));

    const closing = app.close();
    // A start that queued behind the stop wakes when it fails and tries it.
    const next = open(first, version);
    await vi.waitFor(() => expect(first.stopped).toHaveBeenCalledOnce());
    stop.reject(new Error("VM did not stop"));
    await expect(closing).rejects.toThrow();
    await expect(next).rejects.toThrow();
    expect(first.stopped).toHaveBeenCalledTimes(2);
    const waiting = vi.fn();
    const probe = new AbortController();
    capacity
      .acquire(1, { signal: probe.signal, waiting })
      .catch(() => undefined);
    expect(waiting).toHaveBeenCalledOnce();
    probe.abort();

    await (await open(first, version)).close();
    const freed = await capacity.acquire(1);
    freed.release();
  });

  it("frees a stop's capacity once its slow cleanup finishes, without the Module opening again", async () => {
    const capacity = new SandboxCapacity({
      memoryBytes: Number.MAX_SAFE_INTEGER,
      sandboxes: 1,
    });
    const { first, module } = await setup([], {
      capacity,
      timing: { stopRetryMs: 10, teardownObservationMs: 20 },
    });
    const version = await first.release(module.id, "0.1.0", {});
    const id = moduleInstallationId(module.id);
    const app = await open(first, version);
    const cleaned = Promise.withResolvers<void>();
    first.stopped.mockReturnValueOnce(cleaned.promise);

    // Longer than the supervisor waits: the stop is reported pending.
    await expect(app.close()).rejects.toMatchObject({
      code: "cleanup-pending",
    });
    const waiting = vi.fn();
    const next = capacity.acquire(1, { waiting });
    expect(waiting).toHaveBeenCalledOnce();

    // Cleanup finishes by itself; Works notices and gives the share back.
    cleaned.resolve();
    (await next).release();
    expect(
      (await first.modules.loadGatewayContext(id))?.installation.status
    ).toBe("disabled");
    await (await open(first, version)).close();
  });
});
