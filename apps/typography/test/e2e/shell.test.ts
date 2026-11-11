/** The shell in real Chrome: it boots, the eight places are reachable, and the theme switches. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppSession, startApp } from "./support/app";
import { PORTS } from "./support/ports";

const PLACES = [
  "Import",
  "Library",
  "Coverage",
  "Studio",
  "Generate",
  "Reconstruct",
  "Proof",
  "Export",
];

describe("the shell", () => {
  let app: AppSession;

  beforeAll(async () => {
    app = await startApp({ port: PORTS.shell });
  });

  afterAll(async () => {
    await app.close();
  });

  it("opens on Import with an empty project and no errors", async () => {
    await app.page.waitForSelector(".ty-masthead");
    expect(await app.page.title()).toBe("Import - Typography");
    const status = await app.page.locator(".ty-masthead-status").innerText();
    expect(status.toLowerCase()).toContain("no fonts yet");
    expect(app.errors).toEqual([]);
  });

  it("lists the eight places and moves between them by address", async () => {
    const names = await app.page.locator(".ty-strip a").allInnerTexts();
    expect(names.map((name) => name.trim().toLowerCase())).toEqual(
      PLACES.map((place) => place.toLowerCase())
    );
    for (const place of PLACES) {
      await app.goto(`/${place.toLowerCase()}`);
      expect(await app.page.title()).toBe(`${place} - Typography`);
    }
    await app.goto("/nowhere");
    expect(await app.page.locator("main").innerText()).toContain(
      "No such place"
    );
    expect(app.errors).toEqual([]);
  });

  it("switches to black tape and back", async () => {
    await app.goto("/import");
    const toggle = app.page.getByRole("button", { name: "Black tape" });
    await toggle.click();
    expect(
      await app.page.evaluate(() => document.documentElement.dataset.theme)
    ).toBe("black");
    await toggle.click();
    expect(
      await app.page.evaluate(() => document.documentElement.dataset.theme)
    ).not.toBe("black");
  });

  it("serves the samples a first-time user can open", async () => {
    const listings = await app.page.evaluate(async () => {
      const read = async (path: string) =>
        (await (await fetch(path)).json()) as unknown[];
      return {
        evidence: (await read("/evidence/index.json")).length,
        runs: (await read("/recorded-runs/index.json")).length,
        samples: (await read("/samples/index.json")).length,
      };
    });
    expect(listings).toEqual({ evidence: 3, runs: 3, samples: 5 });
  });
});
