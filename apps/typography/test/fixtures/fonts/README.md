# Test font collection

Real fonts the tests import, read, shape and build from. Each file is kept
exactly as its source publishes it, with its licence text beside it. The keys
in `test/helpers/fixtures.ts` (`FONTS`) name them.

| File | Family | Licence | Source | Why it is here |
| --- | --- | --- | --- | --- |
| `Lato-Regular.ttf` | Lato | OFL 1.1 (`Lato-OFL.txt`) | <https://github.com/google/fonts/tree/main/ofl/lato> | Static Latin with TrueType outlines, ligatures (`liga`) and kerning (`kern`). The base case for editing and building. |
| `SofiaSans-wght.ttf` | Sofia Sans | OFL 1.1 (`SofiaSans-OFL.txt`) | <https://github.com/google/fonts/tree/main/ofl/sofiasans> | Variable weight axis. Latin, Greek and Cyrillic. The base case for pinned instances. |
| `NotoSansDevanagari-wdth-wght.ttf` | Noto Sans Devanagari | OFL 1.1 (`NotoSansDevanagari-OFL.txt`) | <https://github.com/google/fonts/tree/main/ofl/notosansdevanagari> | Variable weight and width. Devanagari conjuncts, reached only through shaping. |
| `SourceCodePro-Regular.otf` | Source Code Pro | OFL 1.1 (`SourceCodePro-OFL.txt`) | <https://github.com/adobe-fonts/source-code-pro/blob/release/OTF/SourceCodePro-Regular.otf> | Static face with PostScript (CFF) outlines: glyphs read as cubic segments, never quadratic. |
| `NotoNaskhArabic-wght.ttf` | Noto Naskh Arabic | OFL 1.1 (`NotoNaskhArabic-OFL.txt`) | <https://github.com/google/fonts/blob/main/ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf> | Variable weight axis. Arabic contextual forms: a letter shapes to a different glyph at the start, middle and end of a word, and none of those glyphs has a character. Sets right to left. |
| `DavidLibre-Regular.ttf` | David Libre | OFL 1.1 (`DavidLibre-OFL.txt`) | <https://github.com/google/fonts/tree/main/ofl/davidlibre> | Static Hebrew with Latin. Sets right to left and positions vowel points on their letters. |

The last three rows are verified by `test/workspace/font-collection.test.ts`.
Every file has the byte size its source lists. The variable fonts are renamed
from the bracketed names their sources use (`SofiaSans[wght].ttf`,
`NotoSansDevanagari[wdth,wght].ttf`, `NotoNaskhArabic[wght].ttf`); their bytes
are unchanged.

## What is not here

- **No font collection (`.ttc`).** The `google/fonts` repository holds none:
  its full file tree, listed on 10 November 2026, has 3924 `.ttf` files and no
  `.ttc` or `.otc`. The one upstream collection checked, Noto Sans CJK in
  `notofonts/noto-cjk`, is about 19 MB per file, far over the size wanted
  here. Other upstream repositories were not searched. Tests that need a
  collection assemble one in memory from two fonts above with `collectionOf`
  in `test/helpers/font-files.ts`. That file is a test construction, not a
  published font.
- **No broken files.** The empty file, the text file with a font extension,
  the font cut short and the font with a corrupted table directory are made
  from the fonts above by `test/helpers/font-files.ts`.
