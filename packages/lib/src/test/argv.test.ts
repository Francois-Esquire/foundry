import { describe, expect, it } from "vitest";
import {
  fillArgv,
  parseArgv,
  placeholdersOf,
  shellQuote,
  showArgv,
} from "../argv";

const fill = (template: string, values: Record<string, unknown> = {}) =>
  fillArgv(parseArgv(template), values);

describe("parseArgv and fillArgv", () => {
  it("splits on whitespace and honours quotes and escapes, without expanding", () => {
    expect(fill("npm   i zod")).toEqual(["npm", "i", "zod"]);
    expect(fill(`echo 'a b' "c d" e\\ f`)).toEqual([
      "echo",
      "a b",
      "c d",
      "e f",
    ]);
    expect(fill(`echo '$HOME' "*" ''`)).toEqual(["echo", "$HOME", "*", ""]);
    expect(fill(`printf "say \\"hi\\" \\$x \\n"`)).toEqual([
      "printf",
      'say "hi" $x \\n',
    ]);
  });

  it("fills a placeholder into exactly one argument, never splitting it", () => {
    expect(fill("npm i $pkg", { pkg: "zod; rm -rf ~" })).toEqual([
      "npm",
      "i",
      "zod; rm -rf ~",
    ]);
    expect(
      fill("git log --since=$since -n $count", { count: 3, since: "1 week" })
    ).toEqual(["git", "log", "--since=1 week", "-n", "3"]);
    expect(fill(`echo "v$version"`, { version: "1.2" })).toEqual([
      "echo",
      "v1.2",
    ]);
  });

  it("spreads an array that is a whole argument, one argument per element", () => {
    expect(fill("npm i $pkgs --save", { pkgs: ["zod", "ai"] })).toEqual([
      "npm",
      "i",
      "zod",
      "ai",
      "--save",
    ]);
    expect(() => fill("npm i x$pkgs", { pkgs: ["a"] })).toThrow(
      "$pkgs must be a string, number, or boolean"
    );
  });

  it("names a missing value, an unclosed quote, and a trailing backslash", () => {
    expect(() => fill("npm i $pkg")).toThrow("$pkg has no value");
    expect(() => parseArgv(`echo "open`)).toThrow('has an unclosed "');
    expect(() => parseArgv("echo \\")).toThrow("ends with a backslash");
  });

  it("lists the placeholders a template names", () => {
    expect(placeholdersOf(parseArgv("cp $from $to $from 'x$y' $"))).toEqual([
      "from",
      "to",
    ]);
  });
});

describe("shellQuote", () => {
  it("quotes only what a shell would read differently", () => {
    expect(shellQuote("main")).toBe("main");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    expect(showArgv(["git", "commit", "-m", "fix it"])).toBe(
      "git commit -m 'fix it'"
    );
  });
});
