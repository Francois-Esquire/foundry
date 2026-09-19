import { expect, it } from "vitest";

import { classifyFile } from "../file-classification";

it("classifies by extension and leaves unknown formats alone", () => {
  expect(classifyFile("src/app.tsx")).toEqual({
    extension: "tsx",
    kind: "code",
    mime: "text/typescript",
    name: "app.tsx",
  });
  expect(classifyFile(".gitignore")).toEqual({
    extension: null,
    kind: "other",
    mime: null,
    name: ".gitignore",
  });
});
