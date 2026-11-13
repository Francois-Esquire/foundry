import "../helpers/mock-module-source";
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorksApi } from "~/app/api/client";
import { useEditorFrameState } from "~/app/modules/editor-frame-state";
import { ModuleBuilds } from "~/main/modules/builds/controller";
import { ModuleSessions } from "~/main/modules/runtime/controller";
import type { EditorStateConnect } from "~/shared/editor-state";
import { installEditorModule } from "../helpers/artifact-editors";
import { fakeApi, fakeStorage, openFakeVault } from "../helpers/fake-api";
import { inlineExecution } from "../helpers/inline-execution";
import { successfulBuildRuntime } from "../helpers/module-build";
import { renderApp } from "../helpers/render-app";

const active = vi.hoisted(() => ({ api: undefined as WorksApi | undefined }));
vi.mock("~/app/api/client", () => ({ worksApi: () => active.api }));
afterEach(cleanup);

const RUNTIME_CHANGED = /runtime stopped or changed access/;
const ORIGIN = "module-app://view-token";
const MOUNT = { binding: "binding-1", origin: ORIGIN, view: "editor" };

/** What a View receives: each connect, with the port it reports on. */
function connections(postMessage: { mock: { calls: unknown[][] } }) {
  return postMessage.mock.calls.map(([message, origin, transfer]) => ({
    message: message as EditorStateConnect,
    origin: origin as string,
    port: (transfer as MessagePort[])[0] as MessagePort,
  }));
}

/** A frame whose window records what Works posts to it. */
function fakeFrame() {
  const contentWindow = { postMessage: vi.fn() };
  const frame = new EventTarget() as EventTarget & {
    contentWindow: typeof contentWindow;
  };
  frame.contentWindow = contentWindow;
  return {
    connections: () => connections(contentWindow.postMessage),
    element: frame as unknown as HTMLIFrameElement,
    load: () => frame.dispatchEvent(new Event("load")),
    window: contentWindow,
  };
}

function report(
  connect: EditorStateConnect,
  dirty: boolean,
  change: Record<string, unknown> = {}
) {
  return {
    binding: connect.binding,
    dirty,
    nonce: connect.nonce,
    type: "foundry.editor-state/report",
    version: 1,
    view: connect.view,
    ...change,
  };
}

/** Lets a posted port message arrive. */
const delivered = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("useEditorFrameState", () => {
  it("protects an unbound View through Create and a rejected reconnect", async () => {
    const frame = fakeFrame();
    const { result } = renderHook(() =>
      useEditorFrameState(frame.element, { ...MOUNT, binding: null })
    );
    expect(result.current).toBe("unknown");
    act(() => frame.load());
    const [first] = frame.connections();
    if (!first) {
      throw new Error("no connect");
    }
    expect(first.message.binding).toBeNull();
    first.port.postMessage(report(first.message, false));
    await waitFor(() => expect(result.current).toBe("clean"));
    // Create can replace the View's URL binding. Its existing port still
    // reports current dirty state for the original host mount.
    first.port.postMessage(report(first.message, true));
    await waitFor(() => expect(result.current).toBe("dirty"));
    act(() => frame.load());
    const second = frame.connections().at(-1);
    expect(second?.message.binding).toBeNull();
    // The View refuses a reconnect whose binding no longer matches its URL.
    first.port.postMessage(report(first.message, false));
    await delivered();
    expect(result.current).toBe("dirty");
    second?.port.postMessage(
      report(second.message, false, { binding: "created-binding" })
    );
    await delivered();
    expect(result.current).toBe("dirty");
  });

  it("connects on load to the View's exact origin and follows its reports", async () => {
    const frame = fakeFrame();
    const { result } = renderHook(() =>
      useEditorFrameState(frame.element, MOUNT)
    );
    // Shown: unknown is protected until the View says otherwise.
    expect(result.current).toBe("unknown");
    frame.load();
    const [first] = frame.connections();
    expect(first?.origin).toBe(ORIGIN);
    expect(first?.message).toEqual({
      binding: "binding-1",
      nonce: expect.any(String),
      type: "foundry.editor-state/connect",
      version: 1,
      view: "editor",
    });
    if (!first) {
      throw new Error("no connect");
    }
    first.port.postMessage(report(first.message, true));
    await waitFor(() => expect(result.current).toBe("dirty"));
    first.port.postMessage(report(first.message, false));
    await waitFor(() => expect(result.current).toBe("clean"));
  });

  it("ignores reports of another nonce, binding or View, malformed ones, and stale ports", async () => {
    const frame = fakeFrame();
    const { result } = renderHook(() =>
      useEditorFrameState(frame.element, MOUNT)
    );
    frame.load();
    const [first] = frame.connections();
    if (!first) {
      throw new Error("no connect");
    }
    first.port.postMessage(report(first.message, true));
    await waitFor(() => expect(result.current).toBe("dirty"));
    for (const change of [
      { nonce: "other" },
      { binding: "binding-2" },
      { view: "preview" },
      { version: 2 },
      { extra: true },
    ]) {
      first.port.postMessage(report(first.message, false, change));
    }
    await delivered();
    expect(result.current).toBe("dirty");

    // The frame reloads: still dirty until the new document reports.
    frame.load();
    const [, second] = frame.connections();
    if (!second) {
      throw new Error("no reconnect");
    }
    expect(second.message.nonce).not.toBe(first.message.nonce);
    first.port.postMessage(report(first.message, false));
    await delivered();
    expect(result.current).toBe("dirty");
    second.port.postMessage(report(second.message, false));
    await waitFor(() => expect(result.current).toBe("clean"));
  });

  it("protects a reloaded clean frame until its new connection reports", async () => {
    const frame = fakeFrame();
    const { result } = renderHook(() =>
      useEditorFrameState(frame.element, MOUNT)
    );
    frame.load();
    const [first] = frame.connections();
    if (!first) {
      throw new Error("no connect");
    }
    first.port.postMessage(report(first.message, false));
    await waitFor(() => expect(result.current).toBe("clean"));
    act(() => frame.load());
    expect(result.current).toBe("unknown");
    first.port.postMessage(report(first.message, false));
    await delivered();
    expect(result.current).toBe("unknown");
  });

  it("retains dirty protection when the runtime loses its origin and frame", async () => {
    const frame = fakeFrame();
    const { result, rerender } = renderHook(
      ({ element, origin }) =>
        useEditorFrameState(element, { ...MOUNT, origin }),
      {
        initialProps: {
          element: frame.element as HTMLIFrameElement | null,
          origin: ORIGIN,
        },
      }
    );
    frame.load();
    const [first] = frame.connections();
    if (!first) {
      throw new Error("no connect");
    }
    first.port.postMessage(report(first.message, true));
    await waitFor(() => expect(result.current).toBe("dirty"));
    rerender({ element: null, origin: "" });
    expect(result.current).toBe("dirty");
    first.port.postMessage(report(first.message, false));
    await delivered();
    expect(result.current).toBe("dirty");
  });

  it("connects on a ready only from its frame's window at the View's origin", () => {
    const frame = fakeFrame();
    renderHook(() => useEditorFrameState(frame.element, MOUNT));
    const ready = { type: "foundry.editor-state/ready", version: 1 };
    const post = (init: MessageEventInit) =>
      window.dispatchEvent(new MessageEvent("message", init));
    post({
      data: ready,
      origin: "module-app://other",
      source: frame.window as never,
    });
    post({ data: ready, origin: ORIGIN, source: {} as never });
    post({
      data: { ...ready, version: 2 },
      origin: ORIGIN,
      source: frame.window as never,
    });
    expect(frame.window.postMessage).not.toHaveBeenCalled();
    post({ data: ready, origin: ORIGIN, source: frame.window as never });
    expect(frame.connections()).toHaveLength(1);
  });

  it("guards nothing before a frame shows the View", () => {
    const { result } = renderHook(() => useEditorFrameState(null, MOUNT));
    expect(result.current).toBe("none");
  });

  it("keeps a shown View protected after its frame goes", async () => {
    const frame = fakeFrame();
    const { rerender, result } = renderHook(
      ({ element }) => useEditorFrameState(element, MOUNT),
      { initialProps: { element: frame.element as HTMLIFrameElement | null } }
    );
    frame.load();
    const [first] = frame.connections();
    if (!first) {
      throw new Error("no connect");
    }
    first.port.postMessage(report(first.message, true));
    await waitFor(() => expect(result.current).toBe("dirty"));
    rerender({ element: null });
    expect(result.current).toBe("dirty");
  });

  it("starts a restarted Program's View unknown again", async () => {
    const frame = fakeFrame();
    const { rerender, result } = renderHook(
      ({ origin }) => useEditorFrameState(frame.element, { ...MOUNT, origin }),
      { initialProps: { origin: ORIGIN } }
    );
    frame.load();
    const [first] = frame.connections();
    if (!first) {
      throw new Error("no connect");
    }
    first.port.postMessage(report(first.message, false));
    await waitFor(() => expect(result.current).toBe("clean"));
    rerender({ origin: "module-app://restarted" });
    await waitFor(() => expect(result.current).toBe("unknown"));
  });
});

describe("leaving an editor View", () => {
  async function openEditor() {
    const storage = fakeStorage();
    const editor = await installEditorModule(storage, "Docs", [
      { mimeTypes: ["text/markdown"], mode: "write", view: "editor" },
    ]);
    const sessions = new ModuleSessions({
      execution: inlineExecution,
      library: storage.modules,
      runtime: {
        revoked: () => undefined,
        shutdown: async () => undefined,
        start: async () => ({
          close: async () => undefined,
          origin: "http://127.0.0.1:3000",
        }),
      },
    });
    const builds = new ModuleBuilds({
      execution: inlineExecution,
      library: storage.modules,
      runtime: successfulBuildRuntime,
    });
    active.api = fakeApi(await openFakeVault(), storage.modules, {
      builds,
      sessions,
    });
    const locations: string[] = [];
    const rendered = renderApp(
      `/m/${editor.id}?binding=binding-1&view=editor`,
      { onLocation: (to) => locations.push(to) }
    );
    const iframe = (await screen.findByTitle(
      "Docs editor"
    )) as HTMLIFrameElement;
    // Shown: the guard is armed before the View has said anything.
    await waitFor(() => {
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
    });
    const postMessage = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { postMessage },
    });
    const connect = () => {
      fireEvent.load(iframe);
      const last = connections(postMessage).at(-1);
      if (!last) {
        throw new Error("no connect");
      }
      return last;
    };
    const leaveHome = () =>
      fireEvent.click(
        within(screen.getByRole("navigation", { name: "Main" })).getByRole(
          "link",
          { name: "Home" }
        )
      );
    return {
      connect,
      editor,
      iframe,
      leaveHome,
      locations,
      rendered,
      sessions,
    };
  }

  it("asks before leaving a View that has not reported, and stays mounted on Stay", async () => {
    const view = await openEditor();
    view.leaveHome();
    const prompt = await screen.findByRole("alertdialog", {
      name: "Unsaved changes",
    });
    expect(prompt.textContent).toContain("may have unsaved changes");
    expect(screen.getByTitle("Docs editor")).toBe(view.iframe);
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTitle("Docs editor")).toBe(view.iframe);
    expect(new URL(view.locations.at(-1) ?? "", "app://works").pathname).toBe(
      `/m/${view.editor.id}`
    );
    await view.sessions.shutdown();
  });

  it("guards a dirty View on leave and on unload, and lets a clean one go", async () => {
    const view = await openEditor();
    const { message, port } = view.connect();
    expect(message.binding).toBe("binding-1");
    port.postMessage(report(message, true));
    await delivered();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    view.leaveHome();
    expect(
      (await screen.findByRole("alertdialog", { name: "Unsaved changes" }))
        .textContent
    ).toContain("has unsaved changes");
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));

    port.postMessage(report(message, false));
    await delivered();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    view.leaveHome();
    await waitFor(() => expect(view.locations.at(-1)).toBe("/"));
    expect(screen.queryByTitle("Docs editor")).toBeNull();
    await view.sessions.shutdown();
  });

  it("keeps a dirty frame through runtime restart without retaining its endpoint", async () => {
    const view = await openEditor();
    const { message, port } = view.connect();
    port.postMessage(report(message, true));
    await delivered();
    const oldSource = view.iframe.src;
    const token = new URL(oldSource).hostname;
    await act(async () => {
      await view.sessions.restart(view.editor.id);
    });
    await screen.findByText(RUNTIME_CHANGED);
    expect(screen.getByTitle("Docs editor")).toBe(view.iframe);
    expect(view.iframe.src).toBe(oldSource);
    expect(view.sessions.endpoint(token)).toBeUndefined();
    view.leaveHome();
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.getByTitle("Docs editor")).toBe(view.iframe);
    expect(view.iframe.src).toBe(oldSource);
    await view.sessions.shutdown();
  });

  it("keeps the current View on Stay and changes it only after explicit leave", async () => {
    const view = await openEditor();
    const { message, port } = view.connect();
    port.postMessage(report(message, true));
    await delivered();
    const oldSource = view.iframe.src;
    fireEvent.change(screen.getByRole("combobox", { name: "View" }), {
      target: { value: "home" },
    });
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.getByTitle("Docs editor")).toBe(view.iframe);
    expect(view.iframe.src).toBe(oldSource);
    fireEvent.change(screen.getByRole("combobox", { name: "View" }), {
      target: { value: "home" },
    });
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    await screen.findByTitle("Docs");
    expect(view.iframe.src).not.toBe(oldSource);
    await view.sessions.shutdown();
  });

  it("does not replace a dirty binding's iframe when navigation is denied", async () => {
    const view = await openEditor();
    const oldToken = new URL(view.iframe.src).host;
    const { message, port } = view.connect();
    port.postMessage(report(message, true));
    await delivered();
    const next = `/m/${view.editor.id}?binding=binding-2&view=editor`;
    await act(async () => {
      await view.rendered.router.navigate(next);
    });
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.getByTitle("Docs editor")).toBe(view.iframe);
    expect(view.locations.at(-1)).not.toBe(next);
    await act(async () => {
      await view.rendered.router.navigate(next);
    });
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    await waitFor(() => expect(view.locations.at(-1)).toBe(next));
    expect(await screen.findByTitle("Docs editor")).not.toBe(view.iframe);
    await waitFor(() => {
      const current = screen.getByTitle("Docs editor") as HTMLIFrameElement;
      expect(new URL(current.src).host).not.toBe(oldToken);
      expect(view.sessions.endpoint(oldToken)).toBeUndefined();
    });
    await view.sessions.shutdown();
  });

  it("does not guard a bound route whose app failed to open", async () => {
    const storage = fakeStorage();
    const editor = await installEditorModule(storage, "Docs", [
      { mimeTypes: ["text/markdown"], mode: "write", view: "editor" },
    ]);
    // No runtime: the app fails to open, so no frame ever shows the View.
    active.api = fakeApi(await openFakeVault(), storage.modules);
    const locations: string[] = [];
    renderApp(`/m/${editor.id}?binding=binding-1&view=editor`, {
      onLocation: (to) => locations.push(to),
    });
    await screen.findByText("Module runtime is unavailable");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole(
        "link",
        { name: "Home" }
      )
    );
    await waitFor(() => expect(locations.at(-1)).toBe("/"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("leaves a dirty View only when asked to leave anyway", async () => {
    const view = await openEditor();
    const { message, port } = view.connect();
    port.postMessage(report(message, true));
    await delivered();
    view.leaveHome();
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    });
    await waitFor(() => expect(view.locations.at(-1)).toBe("/"));
    await view.sessions.shutdown();
  });
});
