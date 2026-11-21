import { afterEach, expect, it, vi } from "vitest";
import { editorState } from "../editor-state";

afterEach(() => vi.unstubAllGlobals());

it("accepts only strict parent connections and reports current state on the replacement port", () => {
  const parent = { postMessage: vi.fn() };
  const frame = Object.assign(new EventTarget(), { parent });
  vi.stubGlobal("window", frame);
  let dirty = false;
  let binding = "b1";
  const bridge = editorState(
    () => binding,
    () => dirty
  );
  expect(parent.postMessage).toHaveBeenCalledWith(
    { type: "foundry.editor-state/ready", version: 1 },
    "*"
  );
  const first = { close: vi.fn(), postMessage: vi.fn() };
  const second = { close: vi.fn(), postMessage: vi.fn() };
  const valid = {
    binding: "b1",
    nonce: "n1",
    type: "foundry.editor-state/connect",
    version: 1,
    view: "editor",
  };
  const send = (
    data: unknown,
    source: unknown = parent,
    ports: unknown[] = [first]
  ) => {
    const event = new Event("message");
    Object.assign(event, { data, origin: "null", ports, source });
    frame.dispatchEvent(event);
  };
  for (const data of [
    null,
    [],
    {},
    { ...valid, version: 2 },
    { ...valid, nonce: "" },
    { ...valid, view: "" },
    { ...valid, binding: null },
    { ...valid, extra: true },
  ]) {
    send(data);
  }
  send(valid, {});
  send(valid, parent, []);
  send(valid, parent, [first, second]);
  expect(first.postMessage).not.toHaveBeenCalled();
  send(valid);
  expect(first.postMessage).toHaveBeenLastCalledWith({
    ...valid,
    dirty: false,
    type: "foundry.editor-state/report",
  });
  dirty = true;
  bridge.report();
  bridge.report();
  expect(first.postMessage).toHaveBeenCalledTimes(2);
  expect(first.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ dirty: true })
  );
  send({ ...valid, nonce: "n2" }, parent, [second]);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ dirty: true, nonce: "n2" })
  );
  dirty = false;
  bridge.report();
  expect(first.postMessage).toHaveBeenCalledTimes(2);
  expect(second.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ dirty: false, nonce: "n2" })
  );
  binding = "created-binding";
  send({ ...valid, nonce: "stale-binding" });
  expect(second.close).not.toHaveBeenCalled();
  dirty = true;
  bridge.report();
  expect(second.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ binding: "b1", dirty: true, nonce: "n2" })
  );
  bridge.dispose();
  expect(second.close).toHaveBeenCalledOnce();
  send(valid);
  bridge.report();
  expect(first.postMessage).toHaveBeenCalledTimes(2);
});

it("reports immediately over a real transferred port after ready, including an unbound view", async () => {
  const channel = new MessageChannel();
  const report = new Promise<unknown>((resolve) => {
    channel.port1.onmessage = (event) => resolve(event.data);
  });
  const connect = {
    binding: null,
    nonce: "private-nonce",
    type: "foundry.editor-state/connect",
    version: 1,
    view: "editor",
  };
  const parent = {
    postMessage() {
      const event = new Event("message");
      Object.assign(event, {
        data: connect,
        origin: "null",
        ports: [channel.port2],
        source: parent,
      });
      frame.dispatchEvent(event);
    },
  };
  const frame = Object.assign(new EventTarget(), { parent });
  vi.stubGlobal("window", frame);
  const bridge = editorState(
    () => null,
    () => true
  );
  try {
    expect(await report).toEqual({
      ...connect,
      dirty: true,
      type: "foundry.editor-state/report",
    });
  } finally {
    bridge.dispose();
    channel.port1.close();
  }
});
