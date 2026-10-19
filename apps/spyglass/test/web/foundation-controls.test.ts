// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  SpyglassData,
  SpyglassFoundation,
} from "../../src/web/data/types";
import {
  type ChartSettings,
  defaultChartSettings,
} from "../../src/web/settings/chart-settings";
import { FoundationControls } from "../../src/web/ui/foundation-controls";
import { singleFrame } from "../helpers/frames";
import { twoIslands } from "../helpers/island-fixture";

const foundation: SpyglassFoundation = {
  id: "dependency:zod",
  lobes: [],
  members: [
    {
      direct: true,
      distance: 1,
      territoryId: "island",
      usage: { importingFiles: [], runtimeFiles: [], typeOnlyFiles: [] },
      weight: 1,
    },
    { direct: false, distance: 2, territoryId: "other", weight: 0.45 },
  ],
  name: "zod",
  prominence: 2,
  versions: ["3.0.0", "4.0.0"],
  x: 100,
  y: 0,
};
let root: Root;
let container: HTMLDivElement;
let settings: ChartSettings;
const changed = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  settings = {
    ...defaultChartSettings,
    composition: { hidden: ["files"], solo: [] },
  };
  changed.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function mount(
  data: SpyglassData = {
    ...twoIslands,
    dependencyCoverage: "partial",
    foundations: [foundation],
  },
  sceneReady = true
) {
  function Harness() {
    const [current, setCurrent] = useState(settings);
    return createElement(FoundationControls, {
      actions: {
        sceneReady,
        settings: (next) => {
          settings = typeof next === "function" ? next(current) : next;
          changed(settings);
          setCurrent(settings);
        },
      },
      state: { chartSettings: current, data },
    });
  }
  await act(() => root.render(createElement(Harness)));
}
function input(name: string) {
  const control = container.querySelector<HTMLInputElement>(
    `input[name="${name}"]`
  );
  if (!control) {
    throw new Error(`Missing input ${name}`);
  }
  return control;
}
function button(label: string) {
  const control = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label
  );
  if (!control) {
    throw new Error(`Missing button ${label}`);
  }
  return control;
}
async function select(value: string) {
  const control = container.querySelector("select");
  if (!control) {
    throw new Error("Missing foundation selector");
  }
  await act(() => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("selects dependency evidence without changing layout settings or hiding incomplete coverage", async () => {
  await mount();
  expect(container.textContent).toContain("Partial dependency graph");
  const previous = settings;
  await select(foundation.id);
  expect(settings).toEqual({ ...previous, foundationFocus: foundation.id });
  expect(container.textContent).toContain("Resolved versions: 3.0.0, 4.0.0");
  expect(container.textContent).toContain(
    "Island · Direct dependency · 0 importing files"
  );
  expect(container.textContent).toContain(
    "Other · Transitive, 2 steps · Import usage indirect"
  );
  await select("");
  expect(settings).toEqual(previous);
});

it("keeps unknown direct usage distinct from measured zero and lists every dependency without a ranking cutoff", async () => {
  const foundations = Array.from({ length: 15 }, (_, index) => ({
    ...foundation,
    id: `dependency:${index}`,
    members: foundation.members.map((member) => ({
      ...member,
      usage: undefined,
    })),
    name: `dependency${index}`,
  }));
  await mount({ ...twoIslands, dependencyCoverage: "complete", foundations });
  expect(container.querySelectorAll("option")).toHaveLength(16);
  expect(container.textContent).toContain(
    "All shared groups · 0 groups / 15 dependencies"
  );
  await select("dependency:14");
  expect(container.textContent).toContain("Import usage not measured");
  expect(container.textContent).not.toContain("0 importing files");
});

it("isolates and hides foundations without losing the user's saved hidden layers", async () => {
  await mount();
  const initial = settings;
  await act(() => input("dependency-foundations").click());
  expect(settings.composition.hidden).toEqual([
    "files",
    "dependency-foundations",
  ]);
  await act(() => button("Isolate foundations").click());
  expect(input("dependency-foundations").checked).toBe(true);
  expect(settings.composition.solo).toEqual([
    "sea",
    "dependency-foundations",
    "subsurface-drift",
  ]);
  await act(() => input("dependency-foundations").click());
  expect(settings.composition.solo).toEqual(["sea", "subsurface-drift"]);
  await act(() => button("Restore layers").click());
  expect(settings.composition).toEqual({
    hidden: ["files", "dependency-foundations"],
    solo: [],
  });
  expect(settings).toEqual({ ...initial, composition: settings.composition });
});

it("commits influence only on release, while presentation remains unchanged", async () => {
  await mount();
  const initial = settings;
  const range = input("foundationInfluence");
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(range, "0.5");
    range.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(changed).not.toHaveBeenCalled();
  await act(() =>
    range.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  );
  expect(changed).toHaveBeenCalledExactlyOnceWith({
    ...initial,
    foundationInfluence: 0.5,
  });
});

it("keeps legacy datasets readable and lets a user leave isolation even without foundation data", async () => {
  settings.composition.solo = ["sea"];
  await mount(twoIslands);
  expect(container.textContent).toContain("Dependency graph unavailable");
  expect(container.textContent).toContain("No shared dependency foundations");
  expect(container.querySelector("select")?.disabled).toBe(true);
  expect(input("foundationInfluence").disabled).toBe(true);
  expect(button("Isolate foundations").disabled).toBe(true);
  expect(button("Restore layers").disabled).toBe(false);
  await act(() => button("Restore layers").click());
  expect(settings.composition).toEqual({ hidden: ["files"], solo: [] });
});

it("disables changes until the scene is ready", async () => {
  await mount({ ...twoIslands, foundations: [foundation] }, false);
  expect(
    [...container.querySelectorAll("button, input, select")].every((control) =>
      control.hasAttribute("disabled")
    )
  ).toBe(true);
});

it("distinguishes the same dependency in separate workspaces by its owning frame", async () => {
  const foundations = [
    {
      ...foundation,
      id: "alpha:dependency:zod",
      members: foundation.members.filter(
        (member) => member.territoryId === "island"
      ),
    },
    {
      ...foundation,
      id: "beta:dependency:zod",
      members: foundation.members.filter(
        (member) => member.territoryId === "other"
      ),
    },
  ];
  await mount({
    ...twoIslands,
    foundationGroups: foundations.map((item) => ({
      dependencyIds: [item.id],
      footprint: [],
      id: `group:${item.id}`,
      memberIds: item.members.map((member) => member.territoryId),
    })),
    foundations,
    frames: [
      { ...singleFrame(["island"]), id: "alpha", label: "Alpha workspace" },
      { ...singleFrame(["other"]), id: "beta", label: "Beta workspace" },
    ],
  });
  expect(
    [...container.querySelectorAll("option")].map(
      (option) => option.textContent
    )
  ).toEqual([
    "All shared groups · 2 groups / 2 dependencies",
    "Group: Island · Alpha workspace · 1 dependency",
    "Group: Other · Beta workspace · 1 dependency",
    "Dependency: zod · Alpha workspace · 1 island",
    "Dependency: zod · Beta workspace · 1 island",
  ]);
  await select("group:beta:dependency:zod");
  expect(container.querySelector("h3")?.textContent).toBe(
    "Group: Other · Beta workspace"
  );
  expect(
    container.querySelector('[aria-label="Group islands"]')?.textContent
  ).toBe("Other");
  await select("beta:dependency:zod");
  expect(container.querySelector("h3")?.textContent).toBe(
    "zod · Beta workspace"
  );
  expect(
    container.querySelector('[aria-label="Selected foundation"]')?.textContent
  ).toContain("Other");
});

it("lists every cached shared group and inspects its complete dependency membership", async () => {
  const foundations = Array.from({ length: 32 }, (_, index) => ({
    ...foundation,
    id: `dependency:${index}`,
    name: `Dependency ${index}`,
  }));
  const groups = Array.from({ length: 15 }, (_, index) => ({
    dependencyIds: foundations.map(({ id }) => id),
    footprint: [],
    id: `group:${index}`,
    memberIds: ["island", "other"],
  }));
  await mount({ ...twoIslands, foundationGroups: groups, foundations });
  const before = settings;
  const options = [...container.querySelectorAll("option")];
  expect(options).toHaveLength(1 + 15 + 32);
  expect(options[0]?.textContent).toBe(
    "All shared groups · 15 groups / 32 dependencies"
  );
  expect(options[1]?.textContent).toBe(
    "Group: Island, Other · 32 dependencies"
  );
  expect(
    options.slice(1, 16).every((option) => option.value.startsWith("group:"))
  ).toBe(true);
  await select("group:14");
  expect(settings).toEqual({ ...before, foundationFocus: "group:14" });
  expect(
    container.querySelector('[aria-label="Selected foundation group"] h3')
      ?.textContent
  ).toBe("Group: Island, Other");
  expect(
    [...container.querySelectorAll('[aria-label="Group islands"] li')].map(
      (item) => item.textContent
    )
  ).toEqual(["Island", "Other"]);
  expect(
    container.querySelectorAll('[aria-label="Group dependencies"] li')
  ).toHaveLength(32);
  expect(
    container.querySelector('[aria-label="Group dependencies"]')?.textContent
  ).toContain("Dependency 31");
  expect(container.querySelector("summary")?.textContent).toBe(
    "32 shared dependencies"
  );
  await select("dependency:31");
  expect(
    container.querySelector('[aria-label="Selected foundation group"]')
  ).toBeNull();
  expect(
    container.querySelector('[aria-label="Selected foundation"] h3')
      ?.textContent
  ).toBe("Dependency 31");
});

it("names equal-sized groups by their islands and keeps large groups concise", async () => {
  const [base] = twoIslands.territories;
  if (!base) {
    throw new Error("Missing island fixture");
  }
  const territories = ["Alpha", "Beta", "Delta", "Gamma", "Omega"].map(
    (label) => ({ ...base, id: label, label })
  );
  const foundationGroups = [
    {
      dependencyIds: [foundation.id],
      footprint: [],
      id: "group:one",
      memberIds: ["Beta", "Alpha"],
    },
    {
      dependencyIds: [foundation.id],
      footprint: [],
      id: "group:two",
      memberIds: ["Gamma", "Delta"],
    },
    {
      dependencyIds: [foundation.id],
      footprint: [],
      id: "group:large",
      memberIds: territories.map(({ id }) => id),
    },
  ];
  await mount({
    ...twoIslands,
    foundationGroups,
    foundations: [foundation],
    territories,
  });
  const labels = [...container.querySelectorAll("option")].map(
    (option) => option.textContent
  );
  expect(labels).toContain("Group: Alpha, Beta · 1 dependency");
  expect(labels).toContain("Group: Delta, Gamma · 1 dependency");
  expect(labels).toContain("Group: Alpha, Beta, Delta +2 more · 1 dependency");
  expect(labels[0]).toBe("All shared groups · 3 groups / 1 dependency");
  await select("group:large");
  expect(
    container.querySelectorAll('[aria-label="Group islands"] li')
  ).toHaveLength(5);
  expect(
    container.querySelector('[aria-label="Group islands"]')?.textContent
  ).toContain("Omega");
  expect(container.querySelector("summary")?.textContent).toBe(
    "1 shared dependency"
  );
  expect(container.textContent).toContain("These islands share 1 dependency.");
});
