/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs } from "~/ui/controls/tabs";

afterEach(cleanup);

const TABS = [
  { id: "metrics", label: "Metrics" },
  { disabled: true, id: "kerning", label: "Kerning" },
  { id: "revisions", label: "Revisions" },
] as const;

function Inspector() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("metrics");
  return (
    <Tabs label="Inspector" onChange={setTab} tabs={TABS} value={tab}>
      <p>Showing {tab}</p>
    </Tabs>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe("Tabs", () => {
  it("ties the panel to the tab that is on", () => {
    render(<Inspector />);
    expect(screen.getByRole("tablist", { name: "Inspector" })).toBeTruthy();
    expect(tab("Metrics").getAttribute("aria-selected")).toBe("true");
    expect(tab("Metrics").tabIndex).toBe(0);
    expect(tab("Revisions").tabIndex).toBe(-1);
    const panel = screen.getByRole("tabpanel", { name: "Metrics" });
    expect(panel.id).toBe(tab("Metrics").getAttribute("aria-controls"));
    expect(panel.textContent).toBe("Showing metrics");
  });

  it("switches on click", () => {
    render(<Inspector />);
    fireEvent.click(tab("Revisions"));
    expect(tab("Revisions").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Showing revisions");
  });

  it("moves with the arrow keys, skipping unavailable tabs and wrapping", () => {
    render(<Inspector />);
    tab("Metrics").focus();
    fireEvent.keyDown(tab("Metrics"), { key: "ArrowRight" });
    expect(tab("Revisions").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Revisions"));
    fireEvent.keyDown(tab("Revisions"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Metrics"));
    fireEvent.keyDown(tab("Metrics"), { key: "End" });
    expect(document.activeElement).toBe(tab("Revisions"));
    fireEvent.keyDown(tab("Revisions"), { key: "Home" });
    expect(tab("Metrics").getAttribute("aria-selected")).toBe("true");
  });
});
