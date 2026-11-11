import { describe, expect, it } from "vitest";
import { reasonOf } from "~/lib/reason";

describe("reasonOf", () => {
  it("gives an error's message, and anything else as text", () => {
    expect(reasonOf(new Error("The font engine stopped."))).toBe(
      "The font engine stopped."
    );
    expect(reasonOf("stopped")).toBe("stopped");
  });
});
