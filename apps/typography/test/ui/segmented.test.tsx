/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "~/ui/controls/segmented";

afterEach(cleanup);

const FORMATS = [
  { label: "TrueType", value: "ttf" },
  { label: "OpenType", value: "otf" },
  { disabled: true, label: "Variable", value: "variable" },
] as const;

const option = (name: string) =>
  screen.getByRole("radio", { name }) as HTMLInputElement;

describe("Segmented", () => {
  it("is a named group of radio buttons with one checked", () => {
    render(
      <Segmented
        label="Format"
        onChange={vi.fn()}
        options={FORMATS}
        value="otf"
      />
    );
    expect(screen.getByRole("group", { name: "Format" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(option("OpenType").checked).toBe(true);
    expect(option("TrueType").checked).toBe(false);
  });

  it("puts every option in one group, so the arrow keys move between them", () => {
    render(
      <>
        <Segmented
          label="Format"
          onChange={vi.fn()}
          options={FORMATS}
          value="otf"
        />
        <Segmented
          label="Other format"
          onChange={vi.fn()}
          options={FORMATS}
          value="ttf"
        />
      </>
    );
    const [first, second, , fourth] = screen.getAllByRole(
      "radio"
    ) as HTMLInputElement[];
    expect(first?.name).not.toBe("");
    expect(second?.name).toBe(first?.name);
    expect(fourth?.name).not.toBe(first?.name);
  });

  it("reports the value of the chosen option", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Format"
        onChange={onChange}
        options={FORMATS}
        value="otf"
      />
    );
    fireEvent.click(option("TrueType"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("ttf");
  });

  it("stays on its value until the owner changes it", () => {
    const { rerender } = render(
      <Segmented
        label="Format"
        onChange={vi.fn()}
        options={FORMATS}
        value="otf"
      />
    );
    fireEvent.click(option("TrueType"));
    expect(option("OpenType").checked).toBe(true);
    rerender(
      <Segmented
        label="Format"
        onChange={vi.fn()}
        options={FORMATS}
        value="ttf"
      />
    );
    expect(option("TrueType").checked).toBe(true);
  });

  it("marks an unavailable option and the whole group when switched off", () => {
    const { rerender } = render(
      <Segmented
        label="Format"
        onChange={vi.fn()}
        options={FORMATS}
        value="otf"
      />
    );
    expect(option("Variable").disabled).toBe(true);
    expect(option("TrueType").disabled).toBe(false);
    rerender(
      <Segmented
        disabled
        label="Format"
        onChange={vi.fn()}
        options={FORMATS}
        value="otf"
      />
    );
    expect(
      (screen.getByRole("group", { name: "Format" }) as HTMLFieldSetElement)
        .disabled
    ).toBe(true);
  });
});
