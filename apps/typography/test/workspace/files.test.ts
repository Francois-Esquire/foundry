/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFiles, saveBytes } from "~/workspace/files";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("readFiles", () => {
  it("reads each file's name and bytes, in order", async () => {
    const files = [
      new File([new Uint8Array([0, 1, 0, 0])], "first.ttf"),
      new File(["OTTO"], "second.otf"),
      new File([], "empty.ttf"),
    ];
    expect(await readFiles(files)).toEqual([
      { bytes: new Uint8Array([0, 1, 0, 0]), name: "first.ttf" },
      { bytes: new Uint8Array([0x4f, 0x54, 0x54, 0x4f]), name: "second.otf" },
      { bytes: new Uint8Array(), name: "empty.ttf" },
    ]);
  });
});

describe("saveBytes", () => {
  it("offers the bytes as a download under the given name", async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((object) => {
      blobs.push(object as Blob);
      return "blob:specimen";
    });
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function click(this: HTMLAnchorElement) {
        clicked.push({ download: this.download, href: this.href });
      }
    );

    const bytes = new Uint8Array([0, 1, 0, 0, 9]);
    saveBytes("Lato-Regular.ttf", bytes);

    expect(clicked).toEqual([
      { download: "Lato-Regular.ttf", href: "blob:specimen" },
    ]);
    const [blob] = blobs;
    expect(blob && new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(document.querySelector("a")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:specimen");
  });
});
