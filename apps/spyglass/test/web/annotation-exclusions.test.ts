// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { screenExclusions } from "../../src/web/ui/map-labels/exclusions";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

it("measures only the active shell controls and ignores hidden bars", () => {
  const shell = document.createElement("main");
  shell.className = "spyglass-shell";
  shell.innerHTML =
    '<div class="host"></div><nav class="spyglass-bottom-bar"></nav><div class="spyglass-app-bar"></div>';
  document.body.append(shell);
  const host = shell.querySelector<HTMLElement>(".host");
  const navigation = shell.querySelector<HTMLElement>("nav");
  if (!(host && navigation)) {
    throw new Error("Missing test host");
  }
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
    new DOMRect(100, 200, 600, 400)
  );
  vi.spyOn(navigation, "getBoundingClientRect").mockReturnValue(
    new DOMRect(120, 550, 300, 40)
  );
  const appBar = shell.querySelector<HTMLElement>(".spyglass-app-bar");
  if (!appBar) {
    throw new Error("Missing app bar");
  }
  vi.spyOn(appBar, "getBoundingClientRect").mockReturnValue(
    new DOMRect(140, 500, 200, 25)
  );
  const otherBar = appBar.cloneNode() as HTMLElement;
  otherBar.id = "other-view";
  document.body.append(otherBar);
  vi.spyOn(otherBar, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500)
  );
  expect(screenExclusions(host)).toEqual([
    { bottom: 396, left: 14, right: 326, top: 344 },
    { bottom: 331, left: 34, right: 246, top: 294 },
  ]);
  appBar.hidden = true;
  expect(screenExclusions(host)).toHaveLength(1);
});
