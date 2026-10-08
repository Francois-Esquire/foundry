import "../helpers/mock-module-source";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { worksApi } from "~/app/api/client";
import { Shell } from "~/app/layout/shell";
import { WorksRoutes } from "~/app/routes";
import { ThemeProvider } from "~/app/theme/theme";

// Settings talks to the main process; here it talks to the router in-process.
vi.mock("~/app/api/client", async () => {
  const { fakeApi, openFakeVault } = await import("../helpers/fake-api");
  const api = fakeApi(await openFakeVault());
  return { worksApi: () => api };
});

function renderApp(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <Shell>
            <WorksRoutes />
          </Shell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Shell", () => {
  it("marks the current route in the sidebar", () => {
    renderApp("/settings");

    expect(screen.getByLabelText("Settings").getAttribute("aria-current")).toBe(
      "page"
    );
    expect(
      screen.getByLabelText("Home").getAttribute("aria-current")
    ).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Settings" })
    ).toBeDefined();
  });

  it("renders the module workspace with its files panel", async () => {
    const module = await worksApi().modules.create.call({ name: "demo" });
    renderApp(`/modules/${module.id}`);
    await screen.findByRole("region", { name: "Editor" });

    expect(screen.getByRole("heading", { name: "demo" })).toBeDefined();
    expect(screen.getByText("Files")).toBeDefined();
    expect(screen.getByRole("region", { name: "Editor" })).toBeDefined();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Releases" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole("region", { name: "Preview" })).toBeDefined();
  });

  it("drives the window through the preload bridge", async () => {
    const bridge = {
      close: vi.fn(async () => undefined),
      minimize: vi.fn(async () => undefined),
      mode: vi.fn(async () => "normal" as const),
      setFullscreen: vi.fn(async () => undefined),
    };
    vi.stubGlobal("worksWindow", bridge);
    renderApp("/");

    fireEvent.click(screen.getByLabelText("Minimize"));
    fireEvent.click(screen.getByLabelText("Maximize"));
    fireEvent.click(screen.getByLabelText("Close"));
    await vi.waitFor(() => {
      expect(bridge.setFullscreen).toHaveBeenCalledWith(true);
    });

    expect(bridge.minimize).toHaveBeenCalledTimes(1);
    expect(bridge.close).toHaveBeenCalledTimes(1);
  });

  it("survives rendering without the bridge", () => {
    renderApp("/");

    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.getByLabelText("Home").getAttribute("aria-current")).toBe(
      "page"
    );
  });
});

it("keeps sidebar app links separate from module management", async () => {
  const module = await worksApi().modules.create.call({
    name: "Route separation",
  });
  renderApp(`/modules/${module.id}`);
  await screen.findByRole("region", { name: "Editor" });
  expect(screen.getByLabelText(module.name).getAttribute("href")).toBe(
    `/m/${module.id}`
  );
  expect(
    screen.getByRole("link", { name: "Open app" }).getAttribute("href")
  ).toBe(`/m/${module.id}`);
  expect(screen.queryByTitle(module.name)).toBeNull();
  expect(screen.queryByRole("button", { name: "Build & preview" })).toBeNull();
});

it("opens an app route with management access and no source editor", async () => {
  const module = await worksApi().modules.create.call({ name: "Micro app" });
  renderApp(`/m/${module.id}`);
  expect(
    (await screen.findByRole("link", { name: "Manage module" })).getAttribute(
      "href"
    )
  ).toBe(`/modules/${module.id}`);
  expect(screen.queryByRole("region", { name: "Editor" })).toBeNull();
  expect(
    screen.queryByRole("tablist", { name: "Module management" })
  ).toBeNull();
  await screen.findByText("Module runtime is unavailable");
});
