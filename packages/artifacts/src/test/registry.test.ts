import { describe, expect, it, vi } from "vitest";
import { ArtifactManager } from "../manager";
import { InMemoryArtifactStore } from "../memory";
import { resolveReference } from "../references";
import type { ArtifactBase } from "../registry";
import { createRegistry } from "../registry";
import { required } from "./helpers/required";

describe("Artifact registry", () => {
  it.each<[string, ArtifactBase | null]>([
    ["text/html", "html"],
    ["application/example+html", "html"],
    [" TEXT/HTML; charset=utf-8 ", "html"],
    ["image/svg+xml", "image"],
    ["video/mp4", "video"],
    ["audio/mpeg", "audio"],
    ["text/markdown", "text"],
    ["application/javascript", "text"],
    ["application/json", "structured"],
    ["application/example+json", "structured"],
    ["application/octet-stream", null],
    ["application/example", null],
  ])("recognizes %s without host registrations", (type, base) => {
    const registry = createRegistry({
      fallback: "generic",
      handlers: {
        audio: "audio",
        html: "html",
        image: "image",
        structured: "structured",
        text: "text",
        video: "video",
      },
    });
    expect(registry.resolve({ artifact: { type } })).toEqual({
      base,
      handler: base ?? "generic",
      type,
    });
  });

  it("prefers an exact handler, then a declared base, then the fallback", () => {
    const registry = createRegistry({
      fallback: "generic",
      handlers: { html: "html", structured: "json" },
    });
    registry.register({
      base: "structured",
      handler: "composition",
      type: "composition",
    });
    registry.register({ base: "structured", type: "segmentation" });
    registry.register({ base: "text", type: "document" });
    registry.register({ handler: "custom-html", type: "text/html" });
    expect(
      registry.resolve({ artifact: { type: "composition" } }).handler
    ).toBe("composition");
    expect(
      registry.resolve({ artifact: { type: "segmentation" } }).handler
    ).toBe("json");
    expect(registry.resolve({ artifact: { type: "document" } }).handler).toBe(
      "generic"
    );
    expect(registry.resolve({ artifact: { type: "text/html" } }).handler).toBe(
      "custom-html"
    );
  });

  it("rejects duplicate definitions without changing another registry", () => {
    const first = createRegistry({ fallback: "generic" });
    const second = createRegistry({ fallback: "generic" });
    first.register({ handler: "first", type: "example" });
    expect(() => {
      first.register({ handler: "second", type: "example" });
    }).toThrow("already registered");
    expect(first.resolve({ artifact: { type: "example" } }).handler).toBe(
      "first"
    );
    expect(second.resolve({ artifact: { type: "example" } }).handler).toBe(
      "generic"
    );
  });

  it("resolves in-memory build output and leaves async execution to its host", async () => {
    const artifacts = new ArtifactManager({
      store: new InMemoryArtifactStore(),
    });
    const artifact = await artifacts.create({
      entries: {
        "outputs/index.html": { bytes: "<h1>Hello</h1>", mime: "text/html" },
        "source/main.ts": { bytes: "source" },
      },
      metadata: { entry: "outputs/index.html" },
      name: "Page",
      type: "application/octet-stream",
    });
    const target = await resolveReference(artifacts, {
      artifactId: artifact.id,
    });
    if (target.status !== "available") {
      throw new Error(target.reason);
    }
    const handler = vi.fn(async () => {
      const file = await artifacts.readFile(
        required(target.content).id,
        required(target.entry).path
      );
      return new TextDecoder().decode(required(file).blob);
    });
    const registry = createRegistry({
      fallback: handler,
      handlers: { html: handler },
    });
    const match = registry.resolve(target);
    expect(match.base).toBe("html");
    expect(handler).not.toHaveBeenCalled();
    expect(await match.handler()).toBe("<h1>Hello</h1>");
  });

  it("does not infer a specialized artifact's base from an incidental file", () => {
    const registry = createRegistry({
      fallback: "generic",
      handlers: { html: "html" },
    });
    registry.register({ handler: "module", type: "module" });
    expect(
      registry.resolve({
        artifact: { type: "module" },
        entry: {
          bytes: 0,
          digest: "",
          mime: "text/html",
          path: "index.html",
          type: "file",
        },
      })
    ).toEqual({ base: null, handler: "module", type: "module" });
  });
});
