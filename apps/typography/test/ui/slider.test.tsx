/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Slider } from "~/ui/controls/slider";

afterEach(cleanup);

const STOPS = [
  { name: "Regular", value: 400 },
  { name: "Bold", value: 700 },
];

function WeightSlider({ start = 640 }: { readonly start?: number }) {
  const [weight, setWeight] = useState(start);
  return (
    <Slider
      label="Weight"
      max={1000}
      min={100}
      onChange={setWeight}
      stops={STOPS}
      value={weight}
    />
  );
}

const track = () =>
  screen.getByRole("slider", { name: "Weight" }) as HTMLInputElement;
const readout = () =>
  screen.getByRole("textbox", { name: "Weight value" }) as HTMLInputElement;

describe("Slider", () => {
  it("shows its label, range and value", () => {
    render(<WeightSlider />);
    expect(track().min).toBe("100");
    expect(track().max).toBe("1000");
    expect(track().value).toBe("640");
    expect(readout().value).toBe("640");
  });

  it("moves with the keyboard and keeps the readout in step", () => {
    render(<WeightSlider />);
    fireEvent.keyDown(track(), { key: "ArrowRight" });
    expect(track().value).toBe("641");
    fireEvent.keyDown(track(), { key: "ArrowLeft", shiftKey: true });
    expect(track().value).toBe("631");
    fireEvent.keyDown(track(), { key: "PageUp" });
    expect(track().value).toBe("641");
    fireEvent.keyDown(track(), { key: "Home" });
    expect(track().value).toBe("100");
    fireEvent.keyDown(track(), { key: "End" });
    expect(track().value).toBe("1000");
    expect(readout().value).toBe("1000");
  });

  it("takes over the keys it answers and leaves the rest alone", () => {
    render(<WeightSlider />);
    expect(fireEvent.keyDown(track(), { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(track(), { key: "Tab" })).toBe(true);
  });

  it("does not report a change at the end of the range", () => {
    const onChange = vi.fn();
    render(
      <Slider
        label="Weight"
        max={1000}
        min={100}
        onChange={onChange}
        value={1000}
      />
    );
    fireEvent.keyDown(track(), { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows a drag on the track", () => {
    render(<WeightSlider />);
    fireEvent.change(track(), { target: { value: "312" } });
    expect(readout().value).toBe("312");
  });

  it("takes a typed value on Enter and keeps it inside the range", () => {
    render(<WeightSlider />);
    fireEvent.change(readout(), { target: { value: "455" } });
    expect(track().value).toBe("640");
    fireEvent.keyDown(readout(), { key: "Enter" });
    expect(track().value).toBe("455");

    fireEvent.change(readout(), { target: { value: "5000" } });
    fireEvent.blur(readout());
    expect(track().value).toBe("1000");
    expect(readout().value).toBe("1000");
  });

  it("drops typed text that is not a number, or on Escape", () => {
    render(<WeightSlider />);
    fireEvent.change(readout(), { target: { value: "heavy" } });
    fireEvent.keyDown(readout(), { key: "Enter" });
    expect(readout().value).toBe("640");

    fireEvent.change(readout(), { target: { value: "300" } });
    fireEvent.keyDown(readout(), { key: "Escape" });
    expect(readout().value).toBe("640");
    expect(track().value).toBe("640");
  });

  it("jumps to a named stop and says when it is on one", () => {
    render(<WeightSlider />);
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    expect(track().getAttribute("aria-valuetext")).toBe("640");
    fireEvent.click(bold);
    expect(track().value).toBe("700");
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(track().getAttribute("aria-valuetext")).toBe("700, Bold");
  });

  it("formats the readout when asked", () => {
    const percent = (value: number) => `${value}%`;
    render(
      <Slider
        format={percent}
        label="Width"
        max={151}
        min={25}
        onChange={vi.fn()}
        value={100}
      />
    );
    expect(
      (screen.getByRole("textbox", { name: "Width value" }) as HTMLInputElement)
        .value
    ).toBe("100%");
  });

  it("switches every part off when unavailable", () => {
    render(
      <Slider
        disabled
        label="Weight"
        max={1000}
        min={100}
        onChange={vi.fn()}
        stops={STOPS}
        value={400}
      />
    );
    expect(track().disabled).toBe(true);
    expect(readout().disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Bold" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
