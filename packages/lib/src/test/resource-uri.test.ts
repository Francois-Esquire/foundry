import { describe, expect, test } from "vitest";

import {
  createResourceUrl,
  formatResourceUrl,
  parseResourceUrl,
  ResourceUriError,
} from "../resource-uri";

const SCHEME = "app";

describe("resource URLs", () => {
  test("round-trips resource, identity, and path through URL", () => {
    const value = formatResourceUrl({
      id: "a1b2-c3",
      path: "assets/hello world.js",
      resource: "artifact",
      scheme: SCHEME,
    });

    expect(value).toBe("app://a1b2-c3.artifact/assets/hello%20world.js");
    expect(parseResourceUrl(SCHEME, value)).toEqual({
      id: "a1b2-c3",
      path: "assets/hello world.js",
      resource: "artifact",
    });
  });

  test("uses the final hostname label as the resource kind", () => {
    expect(
      parseResourceUrl(SCHEME, "app://release.family.release/index.html")
    ).toEqual({
      id: "release.family",
      path: "index.html",
      resource: "release",
    });
  });

  test.each(["UPPER", "bad/id", "under_score", "space id", "雪"])(
    "encodes a domain id that cannot be represented directly in a hostname: %s",
    (id) => {
      const value = formatResourceUrl({
        id,
        resource: "artifact",
        scheme: SCHEME,
      });
      expect(value).toMatch(/^app:\/\/id-[0-9a-f.]+\.artifact\/$/);
      expect(parseResourceUrl(SCHEME, value)).toEqual({
        id,
        path: "",
        resource: "artifact",
      });
    }
  );

  test("keeps encoded authority labels within hostname label limits", () => {
    const value = formatResourceUrl({
      id: `migration-${"a".repeat(64)}_legacy`,
      resource: "release",
      scheme: SCHEME,
    });
    const labels = new URL(value).hostname.split(".");
    expect(labels.every((label) => label.length <= 63)).toBe(true);
    expect(parseResourceUrl(SCHEME, value)?.id).toBe(
      `migration-${"a".repeat(64)}_legacy`
    );
  });

  test.each(["../secret", "a/../../secret", "a\\..\\secret", "/root"])(
    "rejects an unsafe formatted path: %s",
    (path) => {
      expect(() =>
        createResourceUrl({
          id: "a1",
          path,
          resource: "artifact",
          scheme: SCHEME,
        })
      ).toThrow(ResourceUriError);
    }
  );

  test.each(["", "APP", "1app", "ap p"])(
    "rejects an invalid scheme: %s",
    (scheme) => {
      expect(() =>
        createResourceUrl({ id: "a1", resource: "artifact", scheme })
      ).toThrow(ResourceUriError);
    }
  );

  test.each([
    "app://a1.artifact/%2e%2e%2fsecret",
    "app://a1.artifact/%2fetc%2fpasswd",
    "app://a1.artifact/a/%5c../secret",
    "app://a1.artifact/a//b",
  ])("rejects a traversal-bearing parsed path: %s", (value) => {
    expect(parseResourceUrl(SCHEME, value)).toBeNull();
  });

  test.each([
    "https://a1.artifact/index.html",
    "app://artifact/without-an-id",
    "app://user@a1.artifact/index.html",
    "app://a1.artifact/index.html?release=other",
  ])("rejects an invalid resource address: %s", (value) => {
    expect(parseResourceUrl(SCHEME, value)).toBeNull();
  });
});
