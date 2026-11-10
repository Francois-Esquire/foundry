/** @vitest-environment happy-dom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "~/app/app";

const NOWHERE = /Nothing lives at #\/nowhere\./;

const goTo = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  });

const currentPlace = () =>
  screen
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent);

beforeEach(() => {
  window.location.hash = "";
});

afterEach(cleanup);

describe("App", () => {
  it("lists the eight places as links to their addresses", () => {
    render(<App />);
    const strip = screen.getByRole("navigation", { name: "Places" });
    const links = Array.from(strip.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#/import",
      "#/library",
      "#/coverage",
      "#/studio",
      "#/generate",
      "#/reconstruct",
      "#/proof",
      "#/export",
    ]);
    expect(links.map((link) => link.textContent)).toContain("Reconstruct");
  });

  it("opens the first place when the address is empty", () => {
    render(<App />);
    expect(currentPlace()).toEqual(["Import"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Import"
    );
  });

  it("opens the place the address names, as after a reload", () => {
    window.location.hash = "#/library";
    render(<App />);
    expect(currentPlace()).toEqual(["Library"]);
    expect(document.title).toBe("Library - Typography");
  });

  it("follows the address as it changes and moves focus to the content", () => {
    render(<App />);
    goTo("#/studio/lato-regular/a");
    expect(currentPlace()).toEqual(["Studio"]);
    expect(document.activeElement).toBe(screen.getByRole("main"));
    goTo("#/export");
    expect(currentPlace()).toEqual(["Export"]);
  });

  it("offers a way back from an address that names no place", () => {
    window.location.hash = "#/nowhere";
    render(<App />);
    expect(currentPlace()).toEqual([]);
    expect(screen.getByText(NOWHERE)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to Import" }).getAttribute("href")
    ).toBe("#/");
  });

  it("loads the design system by address, outside the strip", async () => {
    window.location.hash = "#/system";
    render(<App />);
    expect(currentPlace()).toEqual([]);
    expect(
      await screen.findByRole("heading", { level: 2, name: "Design system" })
    ).toBeTruthy();
  });

  it("shows project status in the masthead when given one", () => {
    render(<App status={<span>Untitled project, 2 fonts</span>} />);
    expect(screen.getByRole("banner").textContent).toContain(
      "Untitled project, 2 fonts"
    );
  });

  it("switches between white and black tape", () => {
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Black tape" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("black");
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("white");
  });
});
