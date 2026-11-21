import { expect, it, vi } from "vitest";
import { allFiles } from "../files";

it("follows cursors through empty pages and includes later Markdown files", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ items: ["first.md"], next: "page2" })
    .mockResolvedValueOnce({ items: [], next: "page3" })
    .mockResolvedValueOnce({ items: ["last.md"], next: null });
  expect(await allFiles(read)).toEqual(["first.md", "last.md"]);
  expect(read.mock.calls).toEqual([
    [{}],
    [{ cursor: "page2" }],
    [{ cursor: "page3" }],
  ]);
});
