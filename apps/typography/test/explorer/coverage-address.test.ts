import { describe, expect, it } from "vitest";
import { coverageAddress } from "~/explorer/coverage-address";

describe("addresses", () => {
  it("names a script by its code and a shared group by its id", () => {
    expect(coverageAddress({ code: "Deva", kind: "script" })).toBe(
      "#/coverage/Deva"
    );
    expect(coverageAddress({ group: "digits", kind: "shared" })).toBe(
      "#/coverage/shared.digits"
    );
  });
});
