// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { screenExclusions } from "../../src/web/ui/map-labels/exclusions";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

it("measures local controls and only the active shell's referenced portaled hint", () => {
  const shell = document.createElement("main");
  shell.className = "spyglass-shell";
  shell.innerHTML =
    '<div class="host"></div><nav class="spyglass-bottom-bar"></nav><div class="spyglass-exploration" aria-describedby="boat-help"></div>';
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
  const hint = document.createElement("p");
  hint.id = "boat-help";
  hint.className = "spyglass-exploration-hint";
  document.body.append(hint);
  vi.spyOn(hint, "getBoundingClientRect").mockReturnValue(
    new DOMRect(140, 500, 200, 25)
  );
  const otherHint = hint.cloneNode() as HTMLElement;
  otherHint.id = "other-view";
  document.body.append(otherHint);
  vi.spyOn(otherHint, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500)
  );
  expect(screenExclusions(host)).toEqual([
    { bottom: 396, left: 14, right: 326, top: 344 },
    { bottom: 331, left: 34, right: 246, top: 294 },
  ]);
  hint.hidden = true;
  expect(screenExclusions(host)).toHaveLength(1);
});
