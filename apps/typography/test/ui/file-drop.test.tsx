/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDrop } from "~/ui/controls/file-drop";
import {
  describeRejected,
  type SortedFiles,
  sortFiles,
} from "~/ui/controls/file-sorting";

afterEach(cleanup);

const FONTS = [".ttf", ".otf"] as const;
const file = (name: string, type = "") => new File(["x"], name, { type });
const names = (files: readonly File[]) => files.map((each) => each.name);

const chooser = () => screen.getByLabelText("Add font files");
const lastOffer = (onFiles: ReturnType<typeof vi.fn>) =>
  onFiles.mock.lastCall?.[0] as SortedFiles;

describe("sortFiles", () => {
  it("accepts by extension, whatever the case or media type", () => {
    const sorted = sortFiles(
      [file("Lato.TTF"), file("Noto.otf", "application/octet-stream")],
      FONTS,
      true
    );
    expect(names(sorted.accepted)).toEqual(["Lato.TTF", "Noto.otf"]);
    expect(sorted.rejected).toEqual([]);
  });

  it("rejects other types and says why", () => {
    const sorted = sortFiles(
      [file("notes.txt"), file("Lato.ttf"), file("ttf")],
      FONTS,
      true
    );
    expect(names(sorted.accepted)).toEqual(["Lato.ttf"]);
    expect(
      sorted.rejected.map(({ file: each, reason }) => [each.name, reason])
    ).toEqual([
      ["notes.txt", "type"],
      ["ttf", "type"],
    ]);
  });

  it("takes only the first acceptable file when one is allowed", () => {
    const sorted = sortFiles(
      [file("scan.png"), file("a.ttf"), file("b.otf")],
      FONTS,
      false
    );
    expect(names(sorted.accepted)).toEqual(["a.ttf"]);
    expect(
      sorted.rejected.map(({ file: each, reason }) => [each.name, reason])
    ).toEqual([
      ["scan.png", "type"],
      ["b.otf", "count"],
    ]);
  });
});

describe("describeRejected", () => {
  it("names the files and the way out", () => {
    const { rejected } = sortFiles(
      [file("notes.txt"), file("logo.png")],
      FONTS,
      true
    );
    expect(describeRejected(rejected, FONTS)).toBe(
      "notes.txt and logo.png were not added. Choose .ttf and .otf files."
    );
  });
});

describe("FileDrop", () => {
  it("is a labelled file input that describes what it takes", () => {
    render(
      <FileDrop accept={FONTS} label="Add font files" onFiles={vi.fn()} />
    );
    const input = chooser() as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe(".ttf,.otf");
    const hint = document.getElementById(
      input.getAttribute("aria-describedby") ?? ""
    );
    expect(hint?.textContent).toContain("Takes .ttf and .otf files.");
  });

  it("reports chosen files, accepted and rejected", () => {
    const onFiles = vi.fn();
    render(
      <FileDrop accept={FONTS} label="Add font files" onFiles={onFiles} />
    );
    fireEvent.change(chooser(), {
      target: { files: [file("Lato.ttf"), file("notes.txt")] },
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(names(lastOffer(onFiles).accepted)).toEqual(["Lato.ttf"]);
    expect(lastOffer(onFiles).rejected[0]?.file.name).toBe("notes.txt");
  });

  it("checks dropped files the same way", () => {
    const onFiles = vi.fn();
    render(
      <FileDrop accept={FONTS} label="Add font files" onFiles={onFiles} />
    );
    const dropped = fireEvent.drop(chooser(), {
      dataTransfer: { files: [file("Noto.otf"), file("photo.jpg")] },
    });
    expect(dropped).toBe(false);
    expect(names(lastOffer(onFiles).accepted)).toEqual(["Noto.otf"]);
    expect(lastOffer(onFiles).rejected[0]?.reason).toBe("type");
  });

  it("switches on while files are held over it", () => {
    render(
      <FileDrop accept={FONTS} label="Add font files" onFiles={vi.fn()} />
    );
    const target = chooser().closest("[data-over]");
    expect(target?.getAttribute("data-over")).toBe("false");
    fireEvent.dragEnter(chooser());
    expect(target?.getAttribute("data-over")).toBe("true");
    fireEvent.dragLeave(chooser());
    expect(target?.getAttribute("data-over")).toBe("false");
  });

  it("names rejected files until the problem is dismissed or put right", () => {
    render(
      <FileDrop accept={FONTS} label="Add font files" onFiles={vi.fn()} />
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(chooser(), { target: { files: [file("notes.txt")] } });
    expect(screen.getByRole("alert").textContent).toContain(
      "notes.txt was not added. Choose .ttf and .otf files."
    );
    fireEvent.change(chooser(), { target: { files: [file("Lato.ttf")] } });
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(chooser(), { target: { files: [file("notes.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves out extra files when only one is allowed", () => {
    const onFiles = vi.fn();
    render(
      <FileDrop
        accept={[".png"]}
        label="Add font files"
        multiple={false}
        onFiles={onFiles}
      />
    );
    fireEvent.drop(chooser(), {
      dataTransfer: { files: [file("front.png"), file("back.png")] },
    });
    expect(names(lastOffer(onFiles).accepted)).toEqual(["front.png"]);
    expect(screen.getByRole("alert").textContent).toContain(
      "Only one file can be added at a time, so back.png was left out."
    );
  });

  it("stays silent when an offer holds no files", () => {
    const onFiles = vi.fn();
    render(
      <FileDrop accept={FONTS} label="Add font files" onFiles={onFiles} />
    );
    fireEvent.drop(chooser(), { dataTransfer: { files: [] } });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
