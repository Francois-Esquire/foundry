# Annotation sharing format and size budget

`share.ts` transports the same version-1 annotation document that local storage
uses. It encodes marks as compact tuples, applies native gzip when that produces
a shorter result, and uses URL-safe base64 in the `notes` query parameter.
`1g.` identifies gzip payloads; `1r.` identifies raw UTF-8 payloads. Native
compression is optional, while decoding a gzip link requires native gzip
decompression. IDs, quotes, contexts, colors, coordinates, and note contents
round-trip without coordinate quantization or dropping marks. Existing query
parameters and heading fragments are retained.

The complete URL, including origin/path/other parameters/fragment, has a practical
2,000-byte QR target and an 8,000-byte hard share limit. The QR target is a product
budget, not a guarantee that every QR size, correction level, or scanner will
work. Links above the hard limit are refused. The annotation document remains
unchanged and available locally. A future server-backed short link would be
needed to share arbitrarily large documents without loss.

Input URL bytes are bounded before payload work. The decoder rejects repeated
`notes` parameters, unknown versions, malformed base64/gzip, invalid UTF-8, invalid
tuple shapes, and invalid document fields. Streaming decompression stops after
1,000,000 expanded bytes. The encoder applies the same expanded limit, so it
never emits a link the decoder refuses for expansion size. Local storage keeps
its separate 8,000,000-character document limit.

## Representative fixtures

Measured 2026-11-05 with native gzip, using the complete base URL
`https://example.com/foundry/marbles/foundation/api/?view=read#the-model`.
The fixtures are executable in `docs/test/helpers/share-fixtures.ts`; tests
assert their round trips and budgets. Runtime gzip implementations may produce
slightly different sizes.

| Fixture | Complete URL bytes | Within QR target | Share link emitted |
| --- | ---: | --- | --- |
| Empty document | 84 | Yes | Yes |
| One highlight | 309 | Yes | Yes |
| Ten highlights | 459 | Yes | Yes |
| One Unicode comment | 413 | Yes | Yes |
| One attached arrow | 319 | Yes | Yes |
| One dense 2,000-point stroke | 11,467 | No | No |
| Thirty incompressible 2,000-character notes | 67,640 | No | No |

Semantic marks stay small because the payload stores text targets and appearance,
not screen rectangles. Freehand strokes and large notes remain the main source
of link growth. The size status must be presented from the actual encoded URL,
not inferred from mark count. Visibility toggling is a local display preference
and does not require rewriting the shared document or URL.
