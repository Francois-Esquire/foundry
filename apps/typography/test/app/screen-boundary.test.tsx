/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenBoundary } from "~/app/screen-boundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STILL_OPEN = /The project is still open/;
const EMPTIES = /Reloading the page empties the project/;

/** A screen that fails while `failing.now` is true, and counts its mounts. */
const flakyScreen = () => {
  const failing: { mounts: number; now: boolean } = { mounts: 0, now: true };
  function Screen() {
    if (failing.now) {
      throw new Error("The screen broke.");
    }
    failing.mounts += 1;
    return <p>The screen is back.</p>;
  }
  return { failing, Screen };
};

describe("ScreenBoundary", () => {
  it("offers to try the place again first, and says reloading empties the project", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { Screen } = flakyScreen();
    render(
      <ScreenBoundary name="Studio">
        <Screen />
      </ScreenBoundary>
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Studio stopped working.");
    expect(alert.textContent).toMatch(STILL_OPEN);
    expect(alert.textContent).toMatch(EMPTIES);
    const actions = Array.from(alert.querySelectorAll("button"), (button) =>
      button.textContent?.trim()
    );
    expect(actions).toEqual([
      "Try this place again",
      "Reload and empty the project",
    ]);
  });

  it("mounts the screen again without reloading the page", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { failing, Screen } = flakyScreen();
    render(
      <ScreenBoundary name="Studio">
        <Screen />
      </ScreenBoundary>
    );
    failing.now = false;
    fireEvent.click(
      screen.getByRole("button", { name: "Try this place again" })
    );
    expect(screen.getByText("The screen is back.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(failing.mounts).toBeGreaterThan(0);
  });

  it("shows the problem again when the screen fails again", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { Screen } = flakyScreen();
    render(
      <ScreenBoundary name="Studio">
        <Screen />
      </ScreenBoundary>
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Try this place again" })
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Studio stopped working."
    );
  });
});
