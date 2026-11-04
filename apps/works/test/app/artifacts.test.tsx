import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorksApi } from "~/app/api/client";
import type { ArtifactExplorer } from "~/main/artifacts/explorer";
import { createModuleLibrary } from "~/main/modules/library";
import { installEditorModule } from "../helpers/artifact-editors";
import { fakeApi, fakeStorage, openFakeVault } from "../helpers/fake-api";
import { renderApp } from "../helpers/render-app";
import { unrecordedSaves } from "../helpers/source-saves";

const UUID = /^[0-9a-f-]{36}$/;

const active = vi.hoisted(() => ({ api: undefined as WorksApi | undefined }));
vi.mock("~/app/api/client", () => ({ worksApi: () => active.api }));
afterEach(cleanup);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/u;
const EMPTY_STATE = /No artifacts yet/u;
const CARD_NAMES = /^(One|Two|Three)$/u;
const FILE_B = /^b\.md/u;
const BETA_EDITOR = /^Beta preview — Beta/u;

function listing() {
  return screen.findByRole("list", { name: "Artifact list" });
}

it("lists product Artifacts with names, type labels and update times, without Module Artifacts", async () => {
  const storage = fakeStorage();
  const module = await storage.modules.create("Hidden module");
  await storage.artifacts.create({
    entries: { "index.html": { bytes: "<h1>Hi</h1>", mime: "text/html" } },
    name: "Landing page",
    type: "text/html",
  });
  await storage.artifacts.create({
    entries: { "report.pdf": { bytes: "%PDF", mime: "application/pdf" } },
    name: "Quarterly report",
    type: "application/pdf",
  });
  active.api = fakeApi(await openFakeVault(), storage.modules, {
    artifacts: storage.explorer,
  });
  renderApp("/artifacts");

  const items = within(await listing()).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  const page = items.find((item) => item.textContent?.includes("Landing page"));
  expect(page?.textContent).toContain("Web page");
  expect(page?.querySelector("time")?.getAttribute("dateTime")).toMatch(
    ISO_TIME
  );
  const report = items.find((item) =>
    item.textContent?.includes("Quarterly report")
  );
  expect(report?.textContent).toContain("application/pdf");
  expect(screen.queryByText(module.name)).toBeNull();
});

it("shows an empty state when only Module Artifacts exist", async () => {
  const store = new InMemoryArtifactStore();
  const modules = createModuleLibrary(store, { saves: unrecordedSaves });
  await modules.create("Only a module");
  active.api = fakeApi(await openFakeVault(), modules, {
    artifacts: fakeStorage(store).explorer,
  });
  renderApp("/artifacts");

  expect(await screen.findByText(EMPTY_STATE)).toBeDefined();
  expect(screen.queryByRole("list", { name: "Artifact list" })).toBeNull();
});

it("shows an error with a retry that recovers", async () => {
  const store = new InMemoryArtifactStore();
  await new ArtifactManager({ store }).create({
    entries: { "notes.md": { bytes: "# Notes", mime: "text/markdown" } },
    name: "Notes",
    type: "text/markdown",
  });
  const real = fakeStorage(store).explorer;
  const list = vi
    .fn<ArtifactExplorer["list"]>()
    .mockRejectedValueOnce(new Error("store locked"))
    .mockImplementation(() => real.list());
  active.api = fakeApi(
    await openFakeVault(),
    createModuleLibrary(store, { saves: unrecordedSaves }),
    {
      artifacts: { ...real, list },
    }
  );
  renderApp("/artifacts");

  const alert = await screen.findByRole("alert");
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  const items = within(await listing()).getAllByRole("listitem");
  expect(items.map((item) => item.querySelector("h2")?.textContent)).toEqual([
    "Notes",
  ]);
  expect(items[0]?.textContent).toContain("Text");
});

it("reports the listing as unavailable when no Artifact service is wired", async () => {
  active.api = fakeApi(
    await openFakeVault(),
    createModuleLibrary(new InMemoryArtifactStore(), { saves: unrecordedSaves })
  );
  renderApp("/artifacts");

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Artifacts are unavailable"
  );
});

const PIXEL = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function card(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function preview(name: string) {
  return card(name).closest("li")?.querySelector("[data-preview]");
}

it("shows real thumbnails for small images and type icons otherwise, falling back when an image fails", async () => {
  const storage = fakeStorage();
  await storage.artifacts.create({
    entries: { "photo.png": { bytes: PIXEL, mime: "image/png" } },
    name: "Photo",
    type: "image/png",
  });
  await storage.artifacts.create({
    entries: {
      "a.md": { bytes: "# A", mime: "text/markdown" },
      "b.md": { bytes: "# B", mime: "text/markdown" },
    },
    name: "Chapters",
    type: "text/markdown",
  });
  active.api = fakeApi(await openFakeVault(), storage.modules, {
    artifacts: storage.explorer,
  });
  renderApp("/artifacts");

  await listing();
  const image = await waitFor(() => {
    const found = preview("Photo")?.querySelector("img");
    expect(found).toBeTruthy();
    return found as HTMLImageElement;
  });
  expect(image.getAttribute("src")).toBe(
    `data:image/png;base64,${Buffer.from(PIXEL).toString("base64")}`
  );
  expect(preview("Photo")?.getAttribute("data-preview")).toBe("thumbnail");
  expect(preview("Chapters")?.getAttribute("data-preview")).toBe("icon");
  expect(card("Chapters").closest("li")?.textContent).toContain("2 files");

  fireEvent.error(image);
  await waitFor(() =>
    expect(preview("Photo")?.getAttribute("data-preview")).toBe("icon")
  );
});

it("moves focus between cards with arrow keys, Home and End", async () => {
  const storage = fakeStorage();
  for (const name of ["One", "Two", "Three"]) {
    await storage.artifacts.create({ name, type: "text/plain" });
  }
  active.api = fakeApi(await openFakeVault(), storage.modules, {
    artifacts: storage.explorer,
  });
  renderApp("/artifacts");

  const [first, second, third] = within(await listing()).getAllByRole(
    "button",
    { name: CARD_NAMES }
  );
  first?.focus();
  fireEvent.keyDown(first as HTMLElement, { key: "ArrowRight" });
  expect(document.activeElement).toBe(second);
  fireEvent.keyDown(second as HTMLElement, { key: "ArrowDown" });
  expect(document.activeElement).toBe(third);
  fireEvent.keyDown(third as HTMLElement, { key: "ArrowRight" });
  expect(document.activeElement).toBe(third);
  fireEvent.keyDown(third as HTMLElement, { key: "Home" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first as HTMLElement, { key: "ArrowUp" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first as HTMLElement, { key: "End" });
  expect(document.activeElement).toBe(third);
  fireEvent.keyDown(third as HTMLElement, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(second);
});

it("offers loading an editor when no installed Module opens the file", async () => {
  const storage = fakeStorage();
  await storage.artifacts.create({
    entries: { "report.pdf": { bytes: "%PDF", mime: "application/pdf" } },
    name: "Report",
    type: "application/pdf",
  });
  active.api = fakeApi(await openFakeVault(), storage.modules, {
    artifacts: storage.explorer,
  });
  const locations: string[] = [];
  renderApp("/artifacts", { onLocation: (to) => locations.push(to) });

  await listing();
  fireEvent.click(card("Report"));
  const dialog = await screen.findByRole("dialog", {
    name: "No editor available",
  });
  expect(dialog.textContent).toContain("report.pdf (application/pdf)");
  fireEvent.click(
    within(dialog).getByRole("link", { name: "Browse the Modules Catalog" })
  );
  await waitFor(() => expect(locations.at(-1)).toBe("/modules"));
});

it("asks for an entry, then an editor, remembers it, and opens the editor route with the selection", async () => {
  const storage = fakeStorage();
  await installEditorModule(storage, "Alpha", [
    { mimeTypes: ["text/markdown"], mode: "write", view: "edit" },
  ]);
  const beta = await installEditorModule(storage, "Beta", [
    { mimeTypes: ["text/markdown"], mode: "read", view: "preview" },
  ]);
  const notes = await storage.artifacts.create({
    entries: {
      "a.md": { bytes: "# A", mime: "text/markdown" },
      "b.md": { bytes: "# B", mime: "text/markdown" },
    },
    name: "Chapters",
    type: "application/vnd.example.chapters",
  });
  active.api = fakeApi(await openFakeVault(), storage.modules, {
    artifacts: storage.explorer,
  });
  const locations: string[] = [];
  renderApp("/artifacts", { onLocation: (to) => locations.push(to) });

  await listing();
  fireEvent.click(card("Chapters"));
  const files = await screen.findByRole("dialog", {
    name: "Choose a file to open",
  });
  expect(
    within(files)
      .getAllByRole("button")
      .map((button) => button.textContent)
  ).toEqual(["", "a.mdtext/markdown", "b.mdtext/markdown"]);
  fireEvent.click(within(files).getByRole("button", { name: FILE_B }));

  const editors = await screen.findByRole("dialog", {
    name: "Open Chapters with",
  });
  expect(editors.textContent).toContain("Works remembers your choice");
  fireEvent.click(within(editors).getByRole("button", { name: BETA_EDITOR }));
  // The View opens with a host-owned binding, never the file's identity.
  const opened = (to: string | undefined) => {
    const url = new URL(to ?? "", "app://works");
    return {
      binding: url.searchParams.get("binding"),
      path: url.pathname,
      search: [...url.searchParams.keys()].sort(),
      view: url.searchParams.get("view"),
    };
  };
  const expected = {
    binding: expect.stringMatching(UUID),
    path: `/m/${beta.id}`,
    search: ["binding", "view"],
    view: "preview",
  };
  await waitFor(() => expect(opened(locations.at(-1))).toEqual(expected));
  const first = opened(locations.at(-1)).binding;

  // The remembered editor opens directly the next time.
  cleanup();
  locations.length = 0;
  renderApp(`/artifacts/${notes.id}`, {
    onLocation: (to) => locations.push(to),
  });
  const again = await screen.findByRole("dialog", {
    name: "Choose a file to open",
  });
  fireEvent.click(within(again).getByRole("button", { name: FILE_B }));
  await waitFor(() => expect(opened(locations.at(-1))).toEqual(expected));
  expect(opened(locations.at(-1)).binding).not.toBe(first);

  // "Open with…" asks again, showing the remembered choice.
  cleanup();
  renderApp("/artifacts");
  await listing();
  fireEvent.click(screen.getByRole("button", { name: "Open Chapters with…" }));
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Choose a file to open" })
    ).getByRole("button", { name: FILE_B })
  );
  const chooser = await screen.findByRole("dialog", {
    name: "Open Chapters with",
  });
  expect(
    within(chooser).getByRole("button", { name: BETA_EDITOR }).textContent
  ).toContain("Your choice");
});

it("opens a Module Artifact addressed by ID as its Module", async () => {
  const storage = fakeStorage();
  const module = await storage.modules.create("Addressed module");
  active.api = fakeApi(await openFakeVault(), storage.modules, {
    artifacts: storage.explorer,
  });
  const locations: string[] = [];
  renderApp(`/artifacts/${module.artifactId}`, {
    onLocation: (to) => locations.push(to),
  });

  await waitFor(() => expect(locations.at(-1)).toBe(`/modules/${module.id}`));
});

it("explains an Artifact with no files and an unknown ID, and returns to the grid when dismissed", async () => {
  const storage = fakeStorage();
  await storage.artifacts.create({ name: "Blank", type: "text/plain" });
  active.api = fakeApi(await openFakeVault(), storage.modules, {
    artifacts: storage.explorer,
  });
  const locations: string[] = [];
  renderApp("/artifacts/missing", { onLocation: (to) => locations.push(to) });

  const failed = await screen.findByRole("dialog", {
    name: "This artifact could not be opened",
  });
  expect(failed.textContent).toContain("This artifact was not found");
  fireEvent.click(within(failed).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(locations.at(-1)).toBe("/artifacts"));
  expect(screen.queryByRole("dialog")).toBeNull();

  card("Blank").focus();
  fireEvent.click(card("Blank"));
  const empty = await screen.findByRole("dialog", { name: "Blank" });
  expect(empty.textContent).toContain("no files yet");
  fireEvent.keyDown(empty, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(card("Blank")));
});

/** The explorer with `create` standing in for product files (main tests prove the real one). */
function creatingExplorer(storage: ReturnType<typeof fakeStorage>) {
  const create = vi.fn(async ({ name }: { name: string }) => {
    const created = await storage.artifacts.create({
      entries: {
        "notes.md": { bytes: `# ${name}\n`, mime: "text/markdown" },
      },
      metadata: { entry: "notes.md" },
      name,
      type: "text/markdown",
    });
    return { id: created.id };
  });
  return { create, explorer: { ...storage.explorer, create } };
}

it("creates a Markdown file from Artifacts and opens it in the editor that edits Markdown", async () => {
  const storage = fakeStorage();
  const editor = await installEditorModule(storage, "Markdown", [
    { mimeTypes: ["text/markdown"], mode: "write", view: "editor" },
  ]);
  const { create, explorer } = creatingExplorer(storage);
  active.api = fakeApi(await openFakeVault(), storage.modules, {
    artifacts: explorer,
  });
  const locations: string[] = [];
  renderApp("/artifacts", { onLocation: (to) => locations.push(to) });

  fireEvent.click(
    await screen.findByRole("button", { name: "New Markdown file" })
  );
  const dialog = await screen.findByRole("dialog", {
    name: "New Markdown file",
  });
  const submit = within(dialog).getByRole("button", { name: "Create file" });
  expect(submit).toHaveProperty("disabled", true);
  fireEvent.change(within(dialog).getByLabelText("File name"), {
    target: { value: "Plans" },
  });
  fireEvent.click(submit);

  await waitFor(() =>
    expect(new URL(locations.at(-1) ?? "", "app://works").pathname).toBe(
      `/m/${editor.id}`
    )
  );
  expect(create).toHaveBeenCalledWith({ name: "Plans" });
});

it("creates a Markdown file with no editor installed and says how to load one", async () => {
  const storage = fakeStorage();
  const { explorer } = creatingExplorer(storage);
  active.api = fakeApi(await openFakeVault(), storage.modules, {
    artifacts: explorer,
  });
  renderApp("/artifacts");

  expect(await screen.findByText(EMPTY_STATE)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New Markdown file" }));
  const dialog = await screen.findByRole("dialog", {
    name: "New Markdown file",
  });
  fireEvent.change(within(dialog).getByLabelText("File name"), {
    target: { value: "Plans" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create file" }));

  const missing = await screen.findByRole("dialog", {
    name: "No editor available",
  });
  expect(missing.textContent).toContain("notes.md (text/markdown)");
  expect(missing.textContent).toContain("Load an editor module");
  // It is listed as a file, not a Module.
  fireEvent.click(within(missing).getByRole("button", { name: "Close" }));
  expect(await screen.findByRole("button", { name: "Plans" })).toHaveProperty(
    "dataset.artifactOpen",
    ""
  );
});
