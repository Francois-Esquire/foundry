// @vitest-environment happy-dom
import { act, createElement, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  ChromeContext,
  ChromeEntry,
} from "../../src/web/ui/chrome-entries";
import { CompassSidebar } from "../../src/web/ui/compass-sidebar";
import { createSpyglassState } from "../../src/web/ui/spyglass-state";
import { useSpyglassState } from "../../src/web/ui/use-spyglass-state";
import { loadSpyglass } from "../helpers/reference-spyglass";

it("mounts declarative extensions directly when the sidebar opens and passes the shared context", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const initial = createSpyglassState(await loadSpyglass());
  const content = vi.fn(({ state }: ChromeContext) =>
    createElement("p", null, `Extension: ${state.mapLayer}`)
  );
  const entries: ChromeEntry[] = [
    {
      component: content,
      description: "An extension",
      id: "extra",
      title: "Extra tools",
    },
  ];
  function Harness() {
    const { state, ...actions } = useSpyglassState(initial);
    const [open, setOpen] = useState(false);
    const opener = useRef<HTMLButtonElement>(null);
    const show = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
      opener.current = event.currentTarget;
      setOpen(true);
    }, []);
    const close = useCallback(() => setOpen(false), []);
    return createElement(CompassSidebar, {
      context: { actions, state },
      entries,
      onClose: close,
      onOpen: show,
      open,
      opener,
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(createElement(Harness)));
    expect(content).not.toHaveBeenCalled();
    await act(() =>
      container
        .querySelector<HTMLButtonElement>(".spyglass-compass-control")
        ?.click()
    );
    expect(container.textContent).toContain("Extra tools");
    expect(content).toHaveBeenCalled();
    expect(container.textContent).toContain("Extension: belonging");
    expect(container.querySelector("#spyglass-sidebar details")).toBeNull();
    await act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Close chart controls"]')
        ?.click()
    );
    expect(container.textContent).not.toContain("Extension: belonging");
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
