import "../helpers/mock-module-source";
import { InMemoryArtifactStore } from "@foundry/artifacts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { LayoutProvider } from "~/app/layout/context";
import { ModuleWorkspace } from "~/app/modules/module-workspace";
import { ModuleManagementPage } from "~/app/pages/module-management";
import { ThemeProvider } from "~/app/theme/theme";
import { ModuleBuilds } from "~/main/modules/builds/controller";
import { createModuleLibrary } from "~/main/modules/library";
import { ModuleSessions } from "~/main/modules/runtime/controller";
import type { ModuleDetails } from "~/shared/modules";
import { fakeApi, openFakeVault } from "../helpers/fake-api";
import { successfulBuildRuntime } from "../helpers/module-build";

const active = vi.hoisted(() => ({
  api: undefined as ReturnType<typeof fakeApi> | undefined,
}));
vi.mock("~/app/api/client", () => ({ worksApi: () => active.api }));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

async function fixture() {
  const library = createModuleLibrary(new InMemoryArtifactStore());
  const module = await library.create("Editor test");
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("Module source missing");
  }
  const builds = new ModuleBuilds(library, successfulBuildRuntime);
  const close = vi.fn(async () => undefined);
  const sessions = new ModuleSessions(library, {
    shutdown: vi.fn(async () => undefined),
    async start() {
      return { close, origin: "http://127.0.0.1:3000" };
    },
  });
  active.api = fakeApi(await openFakeVault(), library, { builds, sessions });
  function editor(initial: ModuleDetails = details as ModuleDetails) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const refresh = vi.fn(async () => {
      const saved = await library.details(module.id);
      if (!saved) {
        throw new Error("Module missing");
      }
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <LayoutProvider>
              <ModuleWorkspace details={saved} refresh={refresh} />
            </LayoutProvider>
          </ThemeProvider>
        </QueryClientProvider>
      );
      return saved;
    });
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <LayoutProvider>
            <ModuleWorkspace details={initial} refresh={refresh} />
          </LayoutProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
    return rendered;
  }
  return { builds, close, details, editor, library, module, sessions };
}

it("recovers unsaved edits after unmount and saves them through the real router", async () => {
  const { library, module, editor } = await fixture();
  const rendered = editor();
  fireEvent.change(screen.getByLabelText("Source code"), {
    target: { value: "local unfinished edit" },
  });
  expect(
    (await library.details(module.id))?.source["packages/app/src/App.tsx"]
  ).not.toBe("local unfinished edit");
  rendered.unmount();
  editor();
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).toBe("local unfinished edit");
  expect(
    screen.getByText("Recovered your local draft. Save it before building.")
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await screen.findByText("Source saved.");
  expect(
    (await library.details(module.id))?.source["packages/app/src/App.tsx"]
  ).toBe("local unfinished edit");
  expect(window.localStorage.getItem(`module-draft:${module.id}`)).toBeNull();
});

it("keeps a recovered stale draft when saving conflicts and can reload current saved source", async () => {
  const { library, module, details, editor } = await fixture();
  const rendered = editor();
  fireEvent.change(screen.getByLabelText("Source code"), {
    target: { value: "my draft" },
  });
  rendered.unmount();
  if (!details.binding) {
    throw new Error("Binding missing");
  }
  await library.saveSource(
    module.id,
    { ...details.source, "packages/app/src/App.tsx": "saved elsewhere" },
    details.binding
  );
  const current = await library.details(module.id);
  if (!current) {
    throw new Error("Module missing");
  }
  editor(current);
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Save source" })
        .hasAttribute("disabled")
    ).toBe(false)
  );
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).toBe("my draft");
  expect(
    (await library.details(module.id))?.source["packages/app/src/App.tsx"]
  ).toBe("saved elsewhere");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  await screen.findByText("Loaded saved source.");
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).toBe("saved elsewhere");
});

it("saves dirty source, streams a build, and starts the new release preview automatically", async () => {
  const { library, module, builds, sessions, editor, close } = await fixture();
  const rendered = editor();
  fireEvent.change(screen.getByLabelText("Source code"), {
    target: { value: "built edit" },
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Releases" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("button", { name: "Build & preview" }));
  await screen.findByText("Build complete");
  await screen.findByTitle("Editor test");
  expect(screen.getByRole("button", { name: "Stop preview" })).toBeDefined();
  expect(
    (await library.details(module.id))?.source["packages/app/src/App.tsx"]
  ).toBe("built edit");
  expect((screen.getByLabelText("Version") as HTMLInputElement).value).toBe(
    "0.1.1"
  );
  rendered.unmount();
  await sessions.shutdown();
  expect(close).toHaveBeenCalledOnce();
  await builds.shutdown();
});

it("discards only the unsaved draft after a prior save", async () => {
  const { editor } = await fixture();
  editor();
  fireEvent.change(screen.getByLabelText("Source code"), {
    target: { value: "first saved edit" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await screen.findByText("Source saved.");
  fireEvent.change(screen.getByLabelText("Source code"), {
    target: { value: "second unfinished edit" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  await screen.findByText("Loaded saved source.");
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).toBe("first saved edit");
});

it("waits for fresh source before editing a module with pre-build cached details", async () => {
  const { library, module, details, builds, sessions } = await fixture();
  if (!details.binding) {
    throw new Error("Binding missing");
  }
  await Array.fromAsync(builds.watch(module.id, "0.1.0", details.binding));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (!active.api) {
    throw new Error("API missing");
  }
  queryClient.setQueryData(
    active.api.modules.details.queryOptions({ input: { id: module.id } })
      .queryKey,
    details
  );
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/modules/${module.id}`]}>
        <ThemeProvider>
          <LayoutProvider>
            <Routes>
              <Route
                element={<ModuleManagementPage />}
                path="/modules/:moduleId"
              />
            </Routes>
          </LayoutProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  expect(screen.queryByLabelText("Source code")).toBeNull();
  const source = await screen.findByLabelText("Source code");
  fireEvent.change(source, { target: { value: "edit after launch" } });
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await screen.findByText("Source saved.");
  expect(
    (await library.details(module.id))?.source["packages/app/src/App.tsx"]
  ).toBe("edit after launch");
  await builds.shutdown();
  await sessions.shutdown();
});

it("reviews draft changes against saved source and keeps them when switching management views", async () => {
  const { editor, details } = await fixture();
  editor();
  fireEvent.change(screen.getByLabelText("Source code"), {
    target: { value: "review this draft" },
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Changes (1)" }), {
    button: 0,
    ctrlKey: false,
  });
  const change = screen.getByRole("region", {
    name: "Changes in packages/app/src/App.tsx",
  });
  expect(change.textContent).toContain(
    details.source["packages/app/src/App.tsx"]
  );
  expect(change.textContent).toContain("review this draft");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Source" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).toBe("review this draft");
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await screen.findByText("Source saved.");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Changes" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.getByText("No unsaved changes.")).toBeDefined();
});
