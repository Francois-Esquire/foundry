import { InMemoryArtifactStore } from "@foundry/artifacts";
import { MODULE_MIME } from "@foundry/modules/constants";
import { afterEach, expect, it, vi } from "vitest";
import { fakeClient, fakeStorage, openFakeVault } from "../helpers/fake-api";

afterEach(() => {
  vi.useRealTimers();
});

it("lists product Artifacts newest first with their recognized family and file count", async () => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });
  const storage = fakeStorage(new InMemoryArtifactStore());
  await storage.modules.create("Library module");
  const page = await storage.artifacts.create({
    entries: { "index.html": { bytes: "<p>Hi</p>", mime: "text/html" } },
    name: "Page",
    type: "text/html",
  });
  vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
  await storage.artifacts.create({
    entries: {
      "a.md": { bytes: "# A", mime: "text/markdown" },
      "b.md": { bytes: "# B", mime: "text/markdown" },
    },
    metadata: { entry: "a.md" },
    name: "Notes",
    type: "application/vnd.example.notes",
  });
  vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
  await storage.artifacts.create({ name: "Empty", type: "application/zip" });
  const archived = await storage.artifacts.create({
    name: "Old",
    type: "text/plain",
  });
  await storage.artifacts.archive(archived.id);
  const client = fakeClient(await openFakeVault(), storage.modules, {
    artifacts: storage.explorer,
  });

  const listed = await client.artifacts.list();

  expect(listed).toEqual([
    {
      base: null,
      files: 0,
      id: expect.any(String),
      name: "Empty",
      thumbnail: false,
      type: "application/zip",
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
    {
      base: "text",
      files: 2,
      id: expect.any(String),
      name: "Notes",
      thumbnail: false,
      type: "application/vnd.example.notes",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      base: "html",
      files: 1,
      id: page.id,
      name: "Page",
      thumbnail: false,
      type: "text/html",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  expect(listed.some((artifact) => artifact.type === MODULE_MIME)).toBe(false);
});

it("is unavailable without an Artifact service", async () => {
  const client = fakeClient(
    await openFakeVault(),
    fakeStorage(new InMemoryArtifactStore()).modules
  );

  await expect(client.artifacts.list()).rejects.toMatchObject({
    code: "SERVICE_UNAVAILABLE",
  });
});
