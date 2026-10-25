// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsRange } from "../../src/web/ui/settings-controls";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function input(value: number) {
  const control = container.querySelector("input");
  if (!control) {
    throw new Error("Missing range");
  }
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(control, String(value));
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return control;
}

it("previews expensive layout changes during drag and commits once on release", async () => {
  const change = vi.fn();
  await act(() =>
    root.render(
      createElement(SettingsRange, {
        commitOnRelease: true,
        label: "Spacing",
        max: 100,
        min: 0,
        name: "spacing",
        onChange: change,
        step: 1,
        value: 10,
      })
    )
  );
  await input(20);
  const control = await input(30);
  expect(container.querySelector("output")?.textContent).toBe("30");
  expect(change).not.toHaveBeenCalled();
  await act(() =>
    control.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  );
  expect(change).toHaveBeenCalledExactlyOnceWith("spacing", 30);
  await act(() =>
    control.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
  );
  expect(change).toHaveBeenCalledOnce();
});

it("cancels an unfinished layout drag and commits keyboard changes", async () => {
  const change = vi.fn();
  await act(() =>
    root.render(
      createElement(SettingsRange, {
        commitOnRelease: true,
        label: "Spacing",
        max: 100,
        min: 0,
        name: "spacing",
        onChange: change,
        step: 1,
        value: 10,
      })
    )
  );
  const control = await input(40);
  await act(() =>
    control.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  );
  expect(control.value).toBe("10");
  expect(change).not.toHaveBeenCalled();
  await input(11);
  await act(() =>
    control.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" })
    )
  );
  expect(change).toHaveBeenCalledExactlyOnceWith("spacing", 11);
});

it("publishes live color controls immediately and follows external resets", async () => {
  const change = vi.fn();
  const props = {
    label: "Exposure",
    max: 3,
    min: 0,
    name: "exposure",
    onChange: change,
    step: 0.05,
    value: 1,
  };
  await act(() => root.render(createElement(SettingsRange, props)));
  const control = await input(1.5);
  expect(change).toHaveBeenCalledExactlyOnceWith("exposure", 1.5);
  await act(() =>
    root.render(createElement(SettingsRange, { ...props, value: 0.5 }))
  );
  expect(control.value).toBe("0.5");
  expect(container.querySelector("output")?.textContent).toBe("0.50");
});
