import { describe, expect, it } from "vitest";
import { formatBytes } from "~/ui/content/byte-size";

describe("a file size for a list", () => {
  it("prints bytes, kilobytes and megabytes", () => {
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(65_536)).toBe("64 kB");
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
  });
});
