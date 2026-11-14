import { afterEach, expect, it, vi } from "vitest";

class Element extends EventTarget {
  value = "";
  textContent = "";
  dataset: Record<string, string> = {};
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("keeps typing during reads and leaves failed explicit reloads dirty and saveable", async () => {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    let value = elements.get(id);
    if (!value) {
      value = new Element();
      elements.set(id, value);
    }
    return value;
  };
  const body = new Element();
  vi.stubGlobal("document", { body, getElementById: element });
  const parent = { postMessage: vi.fn() };
  const frame = Object.assign(new EventTarget(), { parent });
  vi.stubGlobal("window", frame);
  vi.stubGlobal("location", { search: "?binding=b1" });
  let finishRead: ((response: Response) => void) | undefined;
  let reads = 0;
  let finishSave: ((response: Response) => void) | undefined;
  const watch = new TransformStream<Uint8Array, Uint8Array>();
  const writer = watch.writable.getWriter();
  const answer = (output: unknown) => Response.json({ ok: true, output });
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.body) {
        return Promise.resolve(new Response(watch.readable));
      }
      const { alias } = JSON.parse(String(init.body));
      if (alias === "binding") {
        return Promise.resolve(
          answer({ contentId: "c1", mode: "write", name: "file" })
        );
      }
      if (alias === "save") {
        return new Promise<Response>((resolve) => {
          finishSave = resolve;
        });
      }
      reads += 1;
      if (reads === 1) {
        return Promise.resolve(
          answer({ data: btoa("saved"), digest: "d1", next: null })
        );
      }
      if (reads === 2) {
        return new Promise<Response>((resolve) => {
          finishRead = resolve;
        });
      }
      return Promise.reject(new Error("offline"));
    })
  );
  await import("../view");
  const port = { close: vi.fn(), postMessage: vi.fn() };
  const connect = new Event("message");
  Object.assign(connect, {
    data: {
      binding: "b1",
      nonce: "n1",
      type: "foundry.editor-state/connect",
      version: 1,
      view: "editor",
    },
    ports: [port],
    source: parent,
  });
  frame.dispatchEvent(connect);
  await vi.waitFor(() => expect(body.dataset.ready).toBe("true"));
  await writer.write(
    new TextEncoder().encode(
      'data: {"kind":"change","contentId":"c1","entry":{"digest":"d2"}}\n\n'
    )
  );
  await vi.waitFor(() => expect(finishRead).toBeDefined());
  element("text").value = "typing";
  element("text").dispatchEvent(new Event("input"));
  finishRead?.(answer({ data: btoa("remote"), digest: "d2", next: null }));
  await vi.waitFor(() => expect(body.dataset.newer).toBe("true"));
  expect(element("text").value).toBe("typing");
  element("reload").dispatchEvent(new Event("click"));
  await vi.waitFor(() =>
    expect(element("status").textContent).toBe(
      "Could not load the newer version"
    )
  );
  expect(port.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ binding: "b1", dirty: true, nonce: "n1" })
  );
  expect(body.dataset.dirty).toBe("true");
  expect(element("text").value).toBe("typing");
  expect(element("save")).toHaveProperty("disabled", false);
  element("save").dispatchEvent(new Event("click"));
  expect(port.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ dirty: true })
  );
  finishSave?.(
    answer({ current: { digest: "d3", text: "theirs" }, kind: "conflict" })
  );
  await vi.waitFor(() => expect(body.dataset.conflict).toBe("true"));
  expect(port.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ dirty: true })
  );
  element("take").dispatchEvent(new Event("click"));
  expect(port.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ dirty: false })
  );
  element("text").value = "saving";
  element("text").dispatchEvent(new Event("input"));
  element("save").dispatchEvent(new Event("click"));
  element("text").value = "typed while saving";
  element("text").dispatchEvent(new Event("input"));
  finishSave?.(answer({ digest: "d4", kind: "saved" }));
  await vi.waitFor(() => expect(body.dataset.digest).toBe("d4"));
  expect(port.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ dirty: true })
  );
  frame.dispatchEvent(new Event("pagehide"));
  expect(port.close).toHaveBeenCalledOnce();
});
