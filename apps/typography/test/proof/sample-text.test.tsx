/** @vitest-environment happy-dom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SampleText } from "~/proof/sample-text";

afterEach(cleanup);

const PROOF = { characters: new Set([0x41]) };

describe("a sample text in a proof table", () => {
  it("writes the code points, four digits at least, until the browser has the font", () => {
    const { container } = render(
      <SampleText
        browserFont={{ status: "loading" }}
        proof={PROOF}
        text="Aक😀"
      />
    );
    expect(container.textContent).toBe("0041 0915 1F600");
  });

  it("sets the text in the font once it is loaded, with a crossed box for what the font lacks", () => {
    const { container } = render(
      <SampleText
        browserFont={{ family: "Typography Proof b1", status: "loaded" }}
        proof={PROOF}
        text="Aक"
      />
    );
    const set = container.querySelector(".ty-proof-text");
    expect(set?.textContent).toBe("A");
    expect(set?.querySelector('svg[aria-label="Missing U+0915"]')).toBeTruthy();
  });
});
