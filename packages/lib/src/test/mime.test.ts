import { expect, it } from "vitest";

import { HTML_MIME, isTextMime, UNKNOWN_MIME } from "../mime";

it.each([
  [HTML_MIME, true],
  ["text/plain; charset=utf-8", true],
  ["application/json", true],
  ["application/javascript", true],
  ["application/xml", true],
  ["application/ld+json", true],
  ["application/atom+xml", true],
  ["image/png", false],
  [UNKNOWN_MIME, false],
  [null, false],
])("classifies text MIME %j: %s", (mime, textual) => {
  expect(isTextMime(mime)).toBe(textual);
});
