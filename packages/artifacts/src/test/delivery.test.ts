import { describe, expect, it, vi } from "vitest";

import { fileResponse } from "../delivery";
import { InMemoryArtifactStore } from "../memory";
import { ArtifactSystem } from "../system";
import { required } from "./helpers/required";

async function fixture() {
  const artifacts = new ArtifactSystem({ store: new InMemoryArtifactStore() });
  const artifact = await artifacts.create({
    entries: {
      "assets/clip.mp4": { bytes: "0123456789", mime: "video/mp4" },
      empty: { type: "directory" },
      "index.html": { bytes: "<p>page</p>", mime: "text/html" },
    },
    name: "Files",
    type: "text/html",
  });
  return { artifacts, content: required(artifact.content) };
}

describe("file responses", () => {
  it("serves tree paths with entry MIME and caller-owned policy headers", async () => {
    const { artifacts, content } = await fixture();
    const response = await fileResponse(artifacts, content, "index.html", {
      headers: { "Content-Security-Policy": "default-src 'self'" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("Content-Length")).toBe("11");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'"
    );
    expect(await response.text()).toBe("<p>page</p>");
    const override = await fileResponse(artifacts, content, "index.html", {
      headers: { "Content-Type": "text/plain" },
    });
    expect(override.headers.get("Content-Type")).toBe("text/plain");
    await override.body?.cancel();
  });

  it.each([
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=7-99", "789", "bytes 7-9/10"],
  ])("streams a seek using %s", async (range, expected, contentRange) => {
    const { artifacts, content } = await fixture();
    const response = await fileResponse(artifacts, content, "assets/clip.mp4", {
      range,
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Length")).toBe(
      String(expected.length)
    );
    expect(await response.text()).toBe(expected);
  });

  it.each([
    "bytes=-3",
    "bytes=4-1",
    "bytes=0-1,4-5",
    "invalid",
    "bytes=9007199254740992-",
  ])("ignores unsupported or malformed ranges %s", async (range) => {
    const { artifacts, content } = await fixture();
    const response = await fileResponse(artifacts, content, "assets/clip.mp4", {
      range,
    });
    expect(response.status).toBe(200);
    expect(response.headers.has("Content-Range")).toBe(false);
    expect(await response.text()).toBe("0123456789");
  });

  it("rejects unsatisfiable ranges before reading bytes", async () => {
    const { artifacts, content } = await fixture();
    const read = vi.spyOn(artifacts, "readFileRange");
    const response = await fileResponse(artifacts, content, "assets/clip.mp4", {
      range: "bytes=10-",
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["../index.html", "/index.html", "missing", "empty"])(
    "does not read invalid, missing, or structural entries %s",
    async (path) => {
      const { artifacts, content } = await fixture();
      const read = vi.spyOn(artifacts, "readFileRange");
      expect((await fileResponse(artifacts, content, path)).status).toBe(404);
      expect(read).not.toHaveBeenCalled();
    }
  );

  it("closes the source iterator when a media seek is cancelled without prefetching", async () => {
    const { content } = await fixture();
    const next = vi
      .fn()
      .mockResolvedValue({ done: false, value: new Uint8Array([1]) });
    const close = vi.fn().mockResolvedValue({ done: true });
    const body = { [Symbol.asyncIterator]: () => ({ next, return: close }) };
    const reader = {
      readFileRange: vi
        .fn()
        .mockResolvedValue({ body, range: { end: 10, start: 0 } }),
    };
    const response = await fileResponse(reader, content, "assets/clip.mp4");
    expect(next).not.toHaveBeenCalled();
    const stream = required(response.body).getReader();
    await stream.read();
    expect(next).toHaveBeenCalledOnce();
    await stream.cancel("new seek");
    expect(close).toHaveBeenCalledWith("new seek");
    expect(next).toHaveBeenCalledOnce();
  });
});
