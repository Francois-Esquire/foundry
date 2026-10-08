import "../helpers/mock-module-source";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { Shell } from "~/app/layout/shell";
import { WorksRoutes } from "~/app/routes";
import { ThemeProvider } from "~/app/theme/theme";

vi.mock("~/app/api/client", async () => {
  const { fakeApi, openFakeVault } = await import("../helpers/fake-api");
  const api = fakeApi(await openFakeVault());
  return { worksApi: () => api };
});

const manifestPattern = /foundry.module\/1/;
afterEach(cleanup);

it("creates a module from Home and opens persisted source through the real router", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/modules"]}>
          <Shell>
            <WorksRoutes />
          </Shell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
  fireEvent.change(screen.getByLabelText("Module name"), {
    target: { value: "UI module" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create module" }));
  expect(
    await screen.findByRole("heading", { name: "UI module" })
  ).toBeDefined();
  fireEvent.click(
    await screen.findByRole("button", { name: "foundry.module.json" })
  );
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).toMatch(manifestPattern);
});
