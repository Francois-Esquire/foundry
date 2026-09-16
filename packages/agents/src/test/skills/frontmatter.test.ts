import { describe, expect, it } from "vitest";

import { parseFrontmatter, parseYamlBlock } from "../../skills/frontmatter";

describe("parseFrontmatter", () => {
  it("separates frontmatter from the markdown body", () => {
    const { body } = parseFrontmatter("---\nname: x\n---\n# Title\n\nText.");
    expect(body).toBe("# Title\n\nText.");
  });

  it("reads inline and quoted scalars", () => {
    const { data } = parseFrontmatter(
      '---\nname: greeter\ntitle: "Quoted Value"\n---\nbody'
    );
    expect(data.name).toBe("greeter");
    expect(data.title).toBe("Quoted Value");
  });

  it("folds a `>` block scalar onto one line", () => {
    const { data } = parseFrontmatter(
      "---\ndescription: >\n  line one\n  line two\n---\nbody"
    );
    expect(data.description).toBe("line one line two");
  });

  it("keeps newlines for a `|` literal block scalar", () => {
    const { data } = parseFrontmatter(
      "---\ndescription: |\n  line one\n  line two\n---\nbody"
    );
    expect(data.description).toBe("line one\nline two");
  });

  it("returns the whole text as the body when there is no frontmatter", () => {
    const { data, body } = parseFrontmatter(
      "# Just markdown\n\nNo frontmatter."
    );
    expect(data).toEqual({});
    expect(body).toBe("# Just markdown\n\nNo frontmatter.");
  });
});

describe("parseYamlBlock", () => {
  it("parses top-level key/value pairs directly", () => {
    const data = parseYamlBlock('name: greeter\ntitle: "Quoted Value"');
    expect(data.name).toBe("greeter");
    expect(data.title).toBe("Quoted Value");
  });
});
