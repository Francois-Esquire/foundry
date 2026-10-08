import { InMemoryArtifactStore } from "@foundry/artifacts";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { createModuleLibrary } from "~/main/modules/library";
import {
  ModulePreviewError,
  ModulePreviews,
} from "~/main/modules/preview/controller";
import { createPreviewProxy } from "~/main/modules/preview/proxy";
import { router } from "~/main/router/root";
import { openFakeVault } from "../helpers/fake-api";
import { moduleReleasePackage } from "../helpers/module-release";

async function fixture() {
  const library = createModuleLibrary(new InMemoryArtifactStore());
  const { encoded } = await moduleReleasePackage();
  const imported = await library.importPackage(encoded);
  const release = (await library.details(imported.id))?.releases[0];
  if (!release) {
    throw new Error("Imported release missing");
  }
  const version = await library.release(imported.id, release.contentId);
  if (!version) {
    throw new Error("Imported version missing");
  }
  const close = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({ close, origin: "http://127.0.0.1:3000" }));
  const previews = new ModulePreviews(library, {
    shutdown: vi.fn(async () => undefined),
    start,
  });
  return { close, library, previews, start, version };
}

describe("Module previews", () => {
  it("lists retained output-only releases and closes the runtime when the iterator returns", async () => {
    const { library, version, previews, close } = await fixture();
    expect((await library.details(version.moduleId))?.releases).toEqual([
      {
        contentId: version.contentId,
        tag: "1.0.0",
        views: [{ id: "main", path: "/", title: "Fixture" }],
      },
    ]);
    const watch = previews.watch(version.moduleId, version.contentId);
    const { value } = await watch.next();
    expect(value?.origin.startsWith("module-preview://")).toBe(true);
    const token = new URL(value?.origin ?? "").hostname;
    expect(previews.endpoint(token)).toBeDefined();
    const pending = watch.next();
    await watch.return();
    await pending;
    expect(close).toHaveBeenCalledTimes(1);
    expect(previews.endpoint(token)).toBeUndefined();
  });

  it("closes a runtime that finishes startup after cancellation", async () => {
    const { library, version } = await fixture();
    let finish: (() => void) | undefined;
    const close = vi.fn(async () => undefined);
    const previews = new ModulePreviews(library, {
      shutdown: async () => undefined,
      start: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { close, origin: "http://127.0.0.1:3000" };
      },
    });
    const abort = new AbortController();
    const watch = previews.watch(
      version.moduleId,
      version.contentId,
      abort.signal
    );
    const pending = watch.next();
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeDefined());
    abort.abort();
    finish?.();
    await rejection;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not start a missing release", async () => {
    const { version, previews, start } = await fixture();
    await expect(
      previews.watch("absent", version.contentId).next()
    ).rejects.toThrow("not found");
    expect(start).not.toHaveBeenCalled();
  });

  it("proxies views and assets with isolation, without forwarding cookies", async () => {
    const { version, previews } = await fixture();
    const stream = previews.watch(version.moduleId, version.contentId);
    const { value } = await stream.next();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response("view", {
          headers: {
            "content-type": "text/html",
            "set-cookie": "secret=value",
          },
        })
    );
    const proxy = createPreviewProxy(previews, fetcher);
    const response = await proxy(
      new Request(`${value?.origin}/?query=1`, {
        headers: { cookie: "host=secret" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self'"
    );
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(fetcher.mock.calls[0]?.[0]?.toString()).toBe(
      "http://127.0.0.1:3000/?query=1"
    );
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("cookie")).toBe(
      false
    );
    expect((await proxy(new Request(`${value?.origin}/view.js`))).status).toBe(
      200
    );
    for (const path of [
      "/_foundry/health",
      "/_module/gateway",
      "/undeclared",
      "/%00.js",
      "/%zz.js",
      "/%2F%2Fexample.com/file.js",
    ]) {
      const result = await proxy(new Request(`${value?.origin}${path}`));
      if (path.includes("example")) {
        expect(fetcher.mock.calls.at(-1)?.[0]?.toString()).toContain(
          "127.0.0.1"
        );
      } else {
        expect(result.status).toBe(404);
      }
    }
    await stream.return();
    expect((await proxy(new Request(`${value?.origin}/`))).status).toBe(404);
  });

  it("rejects external endpoints, redirects, and stale responses", async () => {
    const endpoint = {
      origin: "http://example.com",
      views: [{ id: "main", path: "/" }],
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.redirect("https://example.com", 302)
    );
    const proxy = createPreviewProxy({ endpoint: () => endpoint }, fetcher);
    const request = new Request("module-preview://token/");
    expect((await proxy(request)).status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
    endpoint.origin = "http://127.0.0.1:3000";
    expect((await proxy(request)).status).toBe(502);
    let active: typeof endpoint | undefined = endpoint;
    const stale = createPreviewProxy({ endpoint: () => active }, async () => {
      active = undefined;
      return new Response("stale");
    });
    expect((await stale(request)).status).toBe(409);
  });
});

it("shutdown cancels active watches and waits for runtime cleanup", async () => {
  const { previews, version, close } = await fixture();
  const watch = previews.watch(version.moduleId, version.contentId);
  await watch.next();
  const pending = watch.next();
  await previews.shutdown();
  await pending;
  expect(close).toHaveBeenCalledTimes(1);
});

it("returns a useful startup error over the real router", async () => {
  const { library, version } = await fixture();
  const previews = new ModulePreviews(library, {
    shutdown: async () => undefined,
    start: () =>
      Promise.reject(
        new ModulePreviewError("Install the runtime before previewing")
      ),
  });
  const client = createRouterClient(router, {
    context: { modules: library, previews, vault: await openFakeVault() },
  });
  const stream = await client.modules.preview({
    contentId: version.contentId,
    id: version.moduleId,
  });
  await expect(stream.next()).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    message: "Install the runtime before previewing",
  });
});
