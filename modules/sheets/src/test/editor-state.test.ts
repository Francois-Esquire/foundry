// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorStateConnection } from "../editor/editor-state";

const nonce = "f413e904-b802-446b-af80-3e0c0e5a2cca";
const nextNonce = "eb3830de-0092-43b8-8f7b-d511f16d97dd";
const connect = {
  binding: "binding",
  nonce,
  type: "foundry.editor-state/connect",
  version: 1,
  view: "editor",
};
const cleanups: (() => void)[] = [];

beforeEach(() => history.replaceState(null, "", "/?binding=binding"));
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) {
    stop();
  }
  vi.restoreAllMocks();
});

function channel() {
  const { port1, port2 } = new MessageChannel();
  const sent = vi.spyOn(port1, "postMessage");
  const close = vi.spyOn(port1, "close");
  cleanups.push(() => {
    port1.close();
    port2.close();
  });
  return { close, port: port1, sent };
}

function receive(
  data: unknown,
  ports: MessagePort[],
  source = window.parent,
  origin = "null"
) {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin, ports, source })
  );
}

function started(dirty = false) {
  const state = new EditorStateConnection(window);
  state.setDirty(dirty);
  cleanups.push(state.start());
  return state;
}

it("installs the listener before Ready and immediately reports current state on the port only", () => {
  const peer = channel();
  const ready = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {
      receive(connect, [peer.port]);
    });
  started(true);
  expect(ready).toHaveBeenCalledExactlyOnceWith(
    { type: "foundry.editor-state/ready", version: 1 },
    "*"
  );
  expect(peer.sent).toHaveBeenCalledExactlyOnceWith({
    ...connect,
    dirty: true,
    type: "foundry.editor-state/report",
  });
});

it.each([
  { ...connect, type: "other" },
  { ...connect, version: 2 },
  { ...connect, nonce: "not-a-uuid" },
  { ...connect, nonce: undefined },
  { ...connect, view: "home" },
  { ...connect, binding: "other" },
  { ...connect, binding: null },
  { ...connect, binding: "" },
  { ...connect, extra: true },
  null,
])("rejects a nonmatching or malformed connection %j", (data) => {
  const state = started();
  const peer = channel();
  receive(data, [peer.port]);
  state.setDirty(true);
  expect(peer.sent).not.toHaveBeenCalled();
});

it("accepts null binding only when its own URL has no binding", () => {
  history.replaceState(null, "", "/");
  started();
  const peer = channel();
  receive({ ...connect, binding: null }, [peer.port]);
  expect(peer.sent).toHaveBeenCalledWith({
    ...connect,
    binding: null,
    dirty: false,
    type: "foundry.editor-state/report",
  });
});

it("rejects another source and connections without exactly one transferred port", () => {
  const state = started();
  const first = channel();
  const second = channel();
  receive(connect, [first.port], {} as Window);
  receive(connect, []);
  receive(connect, [first.port, second.port]);
  state.setDirty(true);
  expect(first.sent).not.toHaveBeenCalled();
  expect(second.sent).not.toHaveBeenCalled();
});

it("closes the old port on reconnect and sends changes only on the current connection", () => {
  const state = started(true);
  const first = channel();
  receive(connect, [first.port]);
  const second = channel();
  receive(
    { ...connect, nonce: nextNonce },
    [second.port],
    window.parent,
    "file://"
  );
  expect(first.close).toHaveBeenCalledOnce();
  state.setDirty(false);
  state.setDirty(false);
  expect(first.sent).toHaveBeenCalledTimes(1);
  expect(second.sent.mock.calls).toEqual([
    [
      {
        ...connect,
        dirty: true,
        nonce: nextNonce,
        type: "foundry.editor-state/report",
      },
    ],
    [
      {
        ...connect,
        dirty: false,
        nonce: nextNonce,
        type: "foundry.editor-state/report",
      },
    ],
  ]);
});

it("keeps current dirty state after reporting fails and supplies it on a fresh connection", () => {
  const state = started();
  const first = channel();
  receive(connect, [first.port]);
  first.sent.mockImplementationOnce(() => {
    throw new Error("port lost");
  });
  expect(() => state.setDirty(true)).not.toThrow();
  expect(first.close).toHaveBeenCalledOnce();
  const second = channel();
  receive({ ...connect, nonce: nextNonce }, [second.port]);
  expect(second.sent).toHaveBeenCalledWith({
    ...connect,
    dirty: true,
    nonce: nextNonce,
    type: "foundry.editor-state/report",
  });
});

it("removes the listener and closes the port on cleanup, and can start again for StrictMode", () => {
  const state = new EditorStateConnection(window);
  const stop = state.start();
  const first = channel();
  receive(connect, [first.port]);
  stop();
  expect(first.close).toHaveBeenCalledOnce();
  const second = channel();
  receive({ ...connect, nonce: nextNonce }, [second.port]);
  expect(second.sent).not.toHaveBeenCalled();
  state.setDirty(true);
  cleanups.push(state.start());
  receive({ ...connect, nonce: nextNonce }, [second.port]);
  expect(second.sent).toHaveBeenCalledWith({
    ...connect,
    dirty: true,
    nonce: nextNonce,
    type: "foundry.editor-state/report",
  });
});

it("keeps an existing null-binding connection scoped after Create changes the URL", () => {
  history.replaceState(null, "", "/");
  const state = started();
  const first = channel();
  receive({ ...connect, binding: null }, [first.port]);
  history.replaceState(null, "", "/?binding=created");
  state.setDirty(true);
  expect(first.sent).toHaveBeenLastCalledWith({
    ...connect,
    binding: null,
    dirty: true,
    type: "foundry.editor-state/report",
  });
  const second = channel();
  receive({ ...connect, binding: null, nonce: nextNonce }, [second.port]);
  expect(second.sent).not.toHaveBeenCalled();
  expect(second.close).toHaveBeenCalledOnce();
});
