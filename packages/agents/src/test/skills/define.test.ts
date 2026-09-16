import { describe, expect, it } from "vitest";

import { defineSkill } from "../../skills/define";

const MANIFEST = [
  "---",
  "name: greeter",
  "description: >",
  "  Greets the user warmly.",
  "  Use when a greeting is needed.",
  "---",
  "",
  "# Greeter",
  "",
  "Say hello.",
].join("\n");

describe("defineSkill", () => {
  it("builds a Skill from a manifest and its in-memory file tree", () => {
    const skill = defineSkill({
      files: { "references/guide.md": "be warm" },
      manifest: MANIFEST,
    });

    expect(skill.name).toBe("greeter");
    expect(skill.description).toBe(
      "Greets the user warmly. Use when a greeting is needed."
    );
    expect(skill.instructions).toBe("# Greeter\n\nSay hello.");
    expect(skill.files).toEqual({ "references/guide.md": "be warm" });
  });

  it("surfaces the manifest as instructions rather than as a bundled file", () => {
    const skill = defineSkill({
      files: { "notes.md": "keep", "SKILL.md": MANIFEST },
      manifest: MANIFEST,
    });

    expect(skill.files).toEqual({ "notes.md": "keep" });
  });

  it("falls back to the supplied name when frontmatter omits it", () => {
    const skill = defineSkill({
      fallbackName: "fallback",
      manifest: "no frontmatter here, just a body",
    });

    expect(skill.name).toBe("fallback");
    expect(skill.instructions).toBe("no frontmatter here, just a body");
  });

  it("omits instructions and files entirely when there are none", () => {
    const skill = defineSkill({
      manifest: "---\nname: bare\ndescription: nothing else\n---\n",
    });

    expect(skill).toEqual({ description: "nothing else", name: "bare" });
  });

  it("carries byte content through untouched", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const skill = defineSkill({
      files: { "logo.png": bytes },
      manifest: "---\nname: binary\n---\n",
    });

    expect(skill.files?.["logo.png"]).toBe(bytes);
  });
});
