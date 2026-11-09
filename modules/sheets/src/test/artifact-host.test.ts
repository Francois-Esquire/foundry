import { expect, it, vi } from "vitest";
import type { WatchEvent } from "../draft";
import {
  type ArtifactTransport,
  ArtifactWorkbookHost,
} from "../editor/artifact-host";
import { WORKBOOK_MAX_BYTES } from "../workbook/file";

const CHUNK = 4;

/**
 * Works' read protocol for one entry, served in small chunks. `digests`
 * gives the digest each read request reports, in order; the binding always
 * reports `digest`.
 */
function entry(
  text: string,
  { digest = "d1", digests = [] as string[], bytes = 0 } = {}
) {
  const data = new TextEncoder().encode(text);
  const requests: { alias: string; input: Record<string, unknown> }[] = [];
  const reads = [...digests];
  const transport: ArtifactTransport = {
    async request(alias, input, signal) {
      signal.throwIfAborted();
      const fields = input as Record<string, unknown>;
      requests.push({ alias, input: fields });
      if (alias === "binding") {
        return {
          contentId: "content",
          entry: { bytes: bytes || data.length, digest },
          mode: "write",
          name: "Budget",
        };
      }
      const offset = Number(fields.offset);
      const end = Math.min(offset + CHUNK, data.length);
      return {
        data: btoa(String.fromCharCode(...data.slice(offset, end))),
        digest: reads.shift() ?? digest,
        next: end < data.length ? end : null,
      };
    },
    watch: () => Promise.reject(new Error("not watched")),
  };
  return { requests, transport };
}

const unaborted = () => new AbortController().signal;

it("reads an entry in chunks as one version, decoding UTF-8 across chunk edges", async () => {
  const text = '{"name":"Ünïcode €"}';
  const { requests, transport } = entry(text);
  const read = await new ArtifactWorkbookHost(transport).read("b", unaborted());
  expect(read).toEqual({
    base: { contentId: "content", digest: "d1" },
    name: "Budget",
    text,
    writable: true,
  });
  expect(requests[0]).toEqual({
    alias: "binding",
    input: { binding: "b", refresh: true },
  });
  expect(
    requests.filter(({ alias }) => alias === "read").length
  ).toBeGreaterThan(3);
});

it("starts over when the entry changes during a read, and gives up after three tries", async () => {
  const retried = entry("abcdefghij", { digests: ["d1", "d2"] });
  const read = await new ArtifactWorkbookHost(retried.transport).read(
    "b",
    unaborted()
  );
  expect(read.text).toBe("abcdefghij");
  expect(
    retried.requests.filter(({ alias }) => alias === "binding")
  ).toHaveLength(2);

  const changing = entry("abcdefghij", {
    digests: ["d2", "d2", "d2", "d2"],
  });
  await expect(
    new ArtifactWorkbookHost(changing.transport).read("b", unaborted())
  ).rejects.toThrow("The workbook kept changing while it was read");
  expect(
    changing.requests.filter(({ alias }) => alias === "binding")
  ).toHaveLength(3);
});

it("refuses an entry larger than a workbook file before reading it", async () => {
  const { requests, transport } = entry("{}", {
    bytes: WORKBOOK_MAX_BYTES + 1,
  });
  await expect(
    new ArtifactWorkbookHost(transport).read("b", unaborted())
  ).rejects.toMatchObject({ code: "too-large" });
  expect(requests.map(({ alias }) => alias)).toEqual(["binding"]);
});

it("stops reading once aborted", async () => {
  const controller = new AbortController();
  const { requests, transport } = entry("abcdefghij");
  const request = transport.request.bind(transport);
  transport.request = async (alias, input, abort) => {
    const answer = await request(alias, input, abort);
    if (alias === "read") {
      controller.abort();
    }
    return answer;
  };
  await expect(
    new ArtifactWorkbookHost(transport).read("b", controller.signal)
  ).rejects.toThrow();
  expect(requests.filter(({ alias }) => alias === "read")).toHaveLength(1);
});

it("resumes a dropped watch after the last version it reported", async () => {
  const queries: string[] = [];
  const event: WatchEvent = {
    contentId: "content",
    entry: { digest: "d2" },
    kind: "change",
  };
  const transport: ArtifactTransport = {
    request: () => Promise.reject(new Error("not requested")),
    watch: async (query) => {
      queries.push(query.toString());
      // Each stream reports one change and then drops.
      return new Response(`data: ${JSON.stringify(event)}\n\n`);
    },
  };
  const controller = new AbortController();
  const events = new ArtifactWorkbookHost(transport)
    .watch("b", { contentId: "content", digest: "d1" }, controller.signal)
    [Symbol.asyncIterator]();
  expect((await events.next()).value).toEqual(event);
  const second = events.next();
  await vi.waitFor(() => expect(queries).toHaveLength(2), { timeout: 3000 });
  expect(queries).toEqual([
    "binding=b&contentId=content&digest=d1",
    "binding=b&contentId=content&digest=d2",
  ]);
  expect((await second).value).toEqual(event);
  controller.abort();
  expect((await events.next()).done).toBe(true);
});

it("explains a save whose answer was too large for the Gateway", async () => {
  const transport: ArtifactTransport = {
    request: () => Promise.reject(new Error("capacity-exceeded")),
    watch: () => Promise.reject(new Error("not watched")),
  };
  await expect(
    new ArtifactWorkbookHost(transport).save("b", "d1", "{}", unaborted())
  ).rejects.toThrow("The version saved elsewhere may be too large for Sheets");
});
