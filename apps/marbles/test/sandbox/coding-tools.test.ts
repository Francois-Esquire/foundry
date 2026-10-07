import { metaOf } from "@foundry/agents/harness";
import type { ToolExecutionOptions } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { CodingToolsContainer } from "../../src/lib/sandbox/coding-tools";
import { createCodingTools } from "../../src/lib/sandbox/coding-tools";

function fixture() {
  const contents = new Map<string, Uint8Array>([
    ["/workspace/a.ts", new TextEncoder().encode("const x = 1;\n")],
  ]);
  const links = new Map<string, string>();
  const container: CodingToolsContainer = {
    commands: {
      exec: vi.fn(async (command) => {
        if (typeof command !== "string" && command[3] === "check-absent") {
          // `test -e "$1" || test -L "$1"`: present, or a dangling link.
          const target = command[4] ?? "";
          const present =
            target === "/workspace" ||
            contents.has(target) ||
            links.has(target);
          return { exitCode: present ? 0 : 1, stderr: "", stdout: "" };
        }
        return { exitCode: 0, stderr: "", stdout: "checked" };
      }),
    },
    files: {
      copyIn: async () => undefined,
      copyOut: async () => ({}),
      isDirectory: async (path) => path === "/workspace",
      list: async () =>
        [...contents.keys()].map((path) => ({ path, type: "file" as const })),
      lstat: async () => ({ type: "file" }),
      readDirectory: async () => [],
      readFile: vi.fn(async (path) => {
        const bytes = contents.get(path);
        if (!bytes) {
          throw new Error("Missing file");
        }
        return bytes;
      }),
      readLink: async () => "",
      realpath: async (path) => {
        const link = [...links].find(
          ([name]) => path === name || path.startsWith(`${name}/`)
        );
        if (link) {
          return path.replace(link[0], link[1]);
        }
        if (path === "/workspace" || contents.has(path)) {
          return path;
        }
        throw new Error("Missing path");
      },
      replaceFile: async () => undefined,
      separator: "/",
      watch: async () => ({ close: async () => undefined }),
      writeFile: vi.fn(async (path, value) => {
        contents.set(
          path,
          typeof value === "string" ? new TextEncoder().encode(value) : value
        );
      }),
    },
  };
  return { container, contents, links, tools: createCodingTools(container) };
}

async function call(
  tools: ReturnType<typeof createCodingTools>,
  name: string,
  input: unknown,
  abortSignal?: AbortSignal
) {
  const mounted = tools[name];
  if (!mounted?.execute) {
    throw new Error("Missing tool");
  }
  const options: ToolExecutionOptions<unknown> = {
    context: undefined,
    messages: [],
    toolCallId: "test-call",
    ...(abortSignal ? { abortSignal } : {}),
  };
  return mounted.execute(input, options);
}

describe("sandbox coding tools", () => {
  it("reads, writes, edits, globs, and searches through the guest facets", async () => {
    const { tools, container, contents } = fixture();
    expect(Object.keys(tools).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
    const { read } = tools;
    if (!read) {
      throw new Error("No read tool");
    }
    expect(metaOf(read).source).toBe("builtin");
    expect(await call(tools, "read", { file_path: "a.ts" })).toContain(
      "const x = 1;"
    );
    await call(tools, "edit", {
      file_path: "a.ts",
      new_string: "2",
      old_string: "1",
      replace_all: false,
    });
    expect(new TextDecoder().decode(contents.get("/workspace/a.ts"))).toContain(
      "x = 2"
    );
    await call(tools, "write", { content: "new", file_path: "nested/new.ts" });
    expect(contents.has("/workspace/nested/new.ts")).toBe(true);
    expect(await call(tools, "glob", { pattern: "**/*.ts" })).toContain("a.ts");
    expect(
      await call(tools, "grep", {
        case_insensitive: false,
        line_numbers: true,
        output_mode: "content",
        path: "/workspace",
        pattern: "const",
      })
    ).toBe("checked");
    expect(container.commands.exec).toHaveBeenCalledWith(
      ["grep", "-r", "-n", "-e", "const", "/workspace"],
      { cwd: "/workspace" }
    );
  });

  it("refuses traversal, absolute outside paths, and symlink escapes before file access", async () => {
    const { tools, container, links } = fixture();
    links.set("/workspace/outside", "/etc");
    await expect(
      call(tools, "read", { file_path: "../secret" })
    ).rejects.toThrow();
    await expect(
      call(tools, "read", { file_path: "/etc/passwd" })
    ).rejects.toThrow("escapes");
    await expect(
      call(tools, "read", { file_path: "outside/passwd" })
    ).rejects.toThrow("escapes");
    await expect(
      call(tools, "write", { content: "danger", file_path: "outside/new/file" })
    ).rejects.toThrow("escapes");
    expect(container.files.readFile).not.toHaveBeenCalled();
    expect(container.files.writeFile).not.toHaveBeenCalled();
  });

  it("checks the workspace root once, and refuses one that is not canonical", async () => {
    const { tools, container } = fixture();
    const realpath = vi.spyOn(container.files, "realpath");
    await call(tools, "read", { file_path: "a.ts" });
    await call(tools, "read", { file_path: "a.ts" });
    expect(
      realpath.mock.calls.filter(([path]) => path === "/workspace")
    ).toHaveLength(1);

    const moved = fixture();
    moved.links.set("/workspace", "/elsewhere");
    await expect(
      call(moved.tools, "read", { file_path: "a.ts" })
    ).rejects.toThrow("canonical");

    // A failed check is not remembered: once the root resolves, tools work.
    moved.links.delete("/workspace");
    expect(await call(moved.tools, "read", { file_path: "a.ts" })).toContain(
      "const x = 1;"
    );
  });

  it("runs shell commands in the VM workspace and forwards turn cancellation", async () => {
    const { tools, container } = fixture();
    const { signal } = new AbortController();
    expect(await call(tools, "bash", { command: "bun test" }, signal)).toBe(
      "checked"
    );
    expect(container.commands.exec).toHaveBeenCalledWith("bun test", {
      cwd: "/workspace",
      signal,
    });
  });
});
