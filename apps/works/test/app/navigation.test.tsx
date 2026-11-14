import "../helpers/mock-module-source";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorksApi } from "~/app/api/client";
import { fakeApi, openFakeVault } from "../helpers/fake-api";
import { renderApp } from "../helpers/render-app";

const active = vi.hoisted(() => ({ api: undefined as WorksApi | undefined }));
vi.mock("~/app/api/client", () => ({ worksApi: () => active.api }));

beforeEach(async () => {
  active.api = fakeApi(await openFakeVault());
});
afterEach(cleanup);

function rail() {
  return screen.getByRole("navigation", { name: "Main" });
}

function railLink(name: string) {
  return within(rail()).getByRole("link", { name });
}

async function createModule(name: string) {
  return await (active.api as WorksApi).modules.create.call({ name });
}

it("places Home and Artifacts above the Module shortcuts and Modules and Settings below", async () => {
  const module = await createModule("Shortcut");
  renderApp("/");
  await within(rail()).findByRole("link", { name: module.name });

  expect(
    within(rail())
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label"))
  ).toEqual(["Home", "Artifacts", module.name, "Modules", "Settings"]);
  const shortcuts = within(rail()).getByRole("list", {
    name: "Module shortcuts",
  });
  expect(within(shortcuts).getAllByRole("link")).toEqual([
    railLink(module.name),
  ]);
  expect(railLink("Home").getAttribute("href")).toBe("/");
  expect(railLink("Artifacts").getAttribute("href")).toBe("/artifacts");
  expect(railLink("Modules").getAttribute("href")).toBe("/modules");
  expect(railLink("Settings").getAttribute("href")).toBe("/settings");
  expect(within(rail()).queryByRole("link", { name: "Manage modules" })).toBe(
    null
  );
});

it("marks the current destination, including a Module's management under Modules", async () => {
  const module = await createModule("Current");
  const { unmount } = renderApp("/artifacts");

  expect(railLink("Artifacts").getAttribute("aria-current")).toBe("page");
  expect(railLink("Home").getAttribute("aria-current")).toBeNull();
  unmount();

  renderApp(`/modules/${module.id}`);
  await screen.findByRole("region", { name: "Editor" });
  expect(railLink("Modules").getAttribute("aria-current")).toBe("page");
  expect(railLink("Home").getAttribute("aria-current")).toBeNull();
  expect(railLink("Artifacts").getAttribute("aria-current")).toBeNull();
});

it("moves focus through the rail with the arrow, Home and End keys", async () => {
  const module = await createModule("Keyboard");
  renderApp("/");
  await within(rail()).findByRole("link", { name: module.name });

  railLink("Home").focus();
  fireEvent.keyDown(railLink("Home"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(railLink("Artifacts"));
  fireEvent.keyDown(railLink("Artifacts"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(railLink(module.name));
  fireEvent.keyDown(railLink(module.name), { key: "End" });
  expect(document.activeElement).toBe(railLink("Settings"));
  fireEvent.keyDown(railLink("Settings"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(railLink("Home"));
  fireEvent.keyDown(railLink("Home"), { key: "ArrowUp" });
  expect(document.activeElement).toBe(railLink("Settings"));
  fireEvent.keyDown(railLink("Settings"), { key: "Home" });
  expect(document.activeElement).toBe(railLink("Home"));
  fireEvent.keyDown(railLink("Home"), { key: "a" });
  expect(document.activeElement).toBe(railLink("Home"));
});

it("opens destinations and Module shortcuts from the rail", async () => {
  const module = await createModule("Opened app");
  renderApp("/");

  fireEvent.click(railLink("Artifacts"));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Artifacts" })
  ).toBeDefined();

  fireEvent.click(railLink("Settings"));
  expect(
    screen.getByRole("heading", { level: 1, name: "Settings" })
  ).toBeDefined();
  expect(screen.getByRole("heading", { name: "Providers" })).toBeDefined();
  expect(screen.getByRole("heading", { name: "Integrations" })).toBeDefined();

  fireEvent.click(
    await within(rail()).findByRole("link", { name: module.name })
  );
  expect(
    (await screen.findByRole("link", { name: "Manage module" })).getAttribute(
      "href"
    )
  ).toBe(`/modules/${module.id}`);
  expect(railLink(module.name).getAttribute("aria-current")).toBe("page");

  fireEvent.click(railLink("Home"));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Your apps" })
  ).toBeDefined();
});

it("shows the Module library as the Modules Catalog tab", async () => {
  const module = await createModule("Catalogued");
  renderApp("/modules");

  expect(
    screen.getByRole("heading", { level: 1, name: "Modules" })
  ).toBeDefined();
  const tabs = within(
    screen.getByRole("tablist", { name: "Modules sections" })
  ).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Catalog",
    "Dashboard",
    "Calls",
    "Workflow Runs",
    "Execution Runs",
    "Artifact Saves",
  ]);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  const catalog = screen.getByRole("tabpanel", { name: "Catalog" });
  expect(within(catalog).getByLabelText("Module name")).toBeDefined();
  expect(
    within(catalog).getByRole("button", { name: "Create module" })
  ).toBeDefined();
  const entry = await within(catalog).findByRole("link", {
    name: new RegExp(module.name, "u"),
  });
  expect(entry.getAttribute("href")).toBe(`/modules/${module.id}`);

  fireEvent.click(entry);
  await screen.findByRole("region", { name: "Editor" });
  const back = screen
    .getAllByRole("link", { name: "Modules" })
    .find((link) => !rail().contains(link));
  fireEvent.click(back as HTMLElement);
  await waitFor(() => {
    expect(screen.getByRole("tabpanel", { name: "Catalog" })).toBeDefined();
  });
});
