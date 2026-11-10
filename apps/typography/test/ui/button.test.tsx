/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "~/ui/controls/button";
import { ToggleButton } from "~/ui/controls/toggle-button";

afterEach(cleanup);

describe("Button", () => {
  it("keeps its name when it carries a symbol", () => {
    render(<Button symbol="download">Export font</Button>);
    const button = screen.getByRole("button", { name: "Export font" });
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
    expect(button.getAttribute("type")).toBe("button");
  });

  it("does not act while unavailable", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Export font
      </Button>
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("ToggleButton", () => {
  it("reports the opposite of its pressed state", () => {
    const onPressedChange = vi.fn();
    render(
      <ToggleButton onPressedChange={onPressedChange} pressed={false}>
        Black tape
      </ToggleButton>
    );
    const button = screen.getByRole("button", { name: "Black tape" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(onPressedChange).toHaveBeenCalledWith(true);
  });
});
