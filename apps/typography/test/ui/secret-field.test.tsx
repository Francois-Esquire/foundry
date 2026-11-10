/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretField } from "~/ui/controls/secret-field";

afterEach(cleanup);

describe("SecretField", () => {
  it("masks what is typed, keeps it from autofill and reports each change", () => {
    const onChange = vi.fn();
    render(
      <SecretField
        hint="Kept in memory for this page only."
        label="Provider key"
        onChange={onChange}
        value=""
      />
    );
    const field = screen.getByLabelText("Provider key");
    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(field, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith("abc");
  });

  it("always says where the secret is kept, and ties the sentence to the field", () => {
    render(
      <SecretField
        hint="Kept in memory for this page only."
        label="Provider key"
        onChange={vi.fn()}
        value="abc"
      />
    );
    const hint = screen.getByText("Kept in memory for this page only.");
    expect(
      screen.getByLabelText("Provider key").getAttribute("aria-describedby")
    ).toBe(hint.id);
  });
});
