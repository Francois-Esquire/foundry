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
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { search: "?binding=b1" });
  let finishRead: ((response: Response) => void) | undefined;
  let reads = 0;
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
  expect(body.dataset.dirty).toBe("true");
  expect(element("text").value).toBe("typing");
  expect(element("save")).toHaveProperty("disabled", false);
});
