import { expect, it, vi } from "vitest";
import type { WatchEvent } from "../draft";
import {
  type ArtifactTransport,
  ArtifactWorkbookHost,
} from "../editor/artifact-host";
import { serverSentEvents } from "../events";

/** A streamed response whose body stays open until told otherwise. */
function stream(...events: string[]) {
  const cancel = vi.fn();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel,
      start(opened) {
        controller = opened;
        for (const event of events) {
          opened.enqueue(new TextEncoder().encode(event));
        }
      },
    })
  );
  return { cancel, end: () => controller?.close(), response };
}

const removed: WatchEvent = { contentId: null, entry: null, kind: "removed" };

it("cancels the response when the caller stops after one event", async () => {
  const { cancel, response } = stream('data: {"n":1}\n\ndata: {"n":2}\n\n');
  const events = serverSentEvents(response);
  expect((await events.next()).value).toEqual({ n: 1 });
  await events.return(undefined);
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it("cancels the response when an event is not JSON", async () => {
  const { cancel, response } = stream("data: {broken\n\n");
  await expect(serverSentEvents(response).next()).rejects.toThrow(SyntaxError);
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it("releases the response when the stream ends", async () => {
  const { end, response } = stream('data: {"n":1}\n\n');
  end();
  const seen: unknown[] = [];
  for await (const event of serverSentEvents(response)) {
    seen.push(event);
  }
  expect(seen).toEqual([{ n: 1 }]);
  expect(response.body?.locked).toBe(false);
});

it("ends and cancels the response when aborted while waiting", async () => {
  const { cancel, response } = stream();
  const controller = new AbortController();
  const waiting = serverSentEvents(response, controller.signal).next();
  controller.abort();
  expect(await waiting).toEqual({ done: true, value: undefined });
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it("closes the watch response once the editor stops reading it", async () => {
  const { cancel, response } = stream(`data: ${JSON.stringify(removed)}\n\n`);
  const transport: ArtifactTransport = {
    request: () => Promise.reject(new Error("not requested")),
    watch: () => Promise.resolve(response),
  };
  const after = { contentId: "content", digest: "d1" };
  for await (const event of new ArtifactWorkbookHost(transport).watch(
    "b",
    after,
    new AbortController().signal
  )) {
    // The session stops following a removed workbook.
    expect(event).toEqual(removed);
    break;
  }
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it("closes failed and malformed watch responses before reconnecting", async () => {
  const refused = stream();
  const malformed = stream("data: {broken\n\n");
  const responses = [
    new Response(refused.response.body, { status: 503 }),
    malformed.response,
  ];
  const controller = new AbortController();
  const transport: ArtifactTransport = {
    request: () => Promise.reject(new Error("not requested")),
    watch: () => {
      const next = responses.shift();
      if (!next) {
        controller.abort();
        return Promise.reject(new Error("no more"));
      }
      return Promise.resolve(next);
    },
  };
  const events = new ArtifactWorkbookHost(transport).watch(
    "b",
    { contentId: "content", digest: "d1" },
    controller.signal
  );
  const seen: WatchEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  expect(seen).toEqual([]);
  expect(refused.cancel).toHaveBeenCalledOnce();
  expect(malformed.cancel).toHaveBeenCalledOnce();
}, 5000);
