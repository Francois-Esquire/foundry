/**
 * Generates the Unicode context's data from @unicode/unicode-17.0.0 and
 * cldr-misc-modern, the only place either package is read. Run it from
 * apps/typography with `bun scripts/build-unicode-data.ts`; the output in
 * src/unicode/data is committed and running it again changes nothing.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import bidiClasses from "@unicode/unicode-17.0.0/Bidi_Class/index.mjs";
import decodeRanges from "@unicode/unicode-17.0.0/decode-ranges.mjs";
import generalCategories from "@unicode/unicode-17.0.0/General_Category/index.mjs";
import unicode from "@unicode/unicode-17.0.0/index.mjs";
import unicodeNames from "@unicode/unicode-17.0.0/Names/index.mjs";
import uppercase from "@unicode/unicode-17.0.0/Simple_Case_Mapping/Uppercase/code-points.mjs";
import { codePointDigits } from "~/lib/code-point";
import {
  hangulSyllableName,
  isHangulSyllable,
  type NameRule,
} from "../src/unicode/algorithmic-names";
import { encodeCodePoints } from "../src/unicode/code-point-set";
import { expandExemplarSet } from "../src/unicode/exemplar-set";
import { encodeNames } from "../src/unicode/name-table";

const MAX_CODE_POINT = 0x10_ff_ff;
const RADIX = 36;
const NAME_CHUNK_BYTES = 70_000;
const LINE_WIDTH = 80;
const UNKNOWN_SCRIPT = "Zzzz";

/** ISO 15924 codes for Unicode script names, from PropertyValueAliases.txt. */
const ISO_15924 = new Map(
  `Adlam Adlm,Ahom Ahom,Anatolian_Hieroglyphs Hluw,Arabic Arab,Armenian Armn,
Avestan Avst,Balinese Bali,Bamum Bamu,Bassa_Vah Bass,Batak Batk,Bengali Beng,
Beria_Erfe Berf,Bhaiksuki Bhks,Bopomofo Bopo,Brahmi Brah,Braille Brai,
Buginese Bugi,Buhid Buhd,Canadian_Aboriginal Cans,Carian Cari,
Caucasian_Albanian Aghb,Chakma Cakm,Cham Cham,Cherokee Cher,Chorasmian Chrs,
Common Zyyy,Coptic Copt,Cuneiform Xsux,Cypriot Cprt,Cypro_Minoan Cpmn,
Cyrillic Cyrl,Deseret Dsrt,Devanagari Deva,Dives_Akuru Diak,Dogra Dogr,
Duployan Dupl,Egyptian_Hieroglyphs Egyp,Elbasan Elba,Elymaic Elym,
Ethiopic Ethi,Garay Gara,Georgian Geor,Glagolitic Glag,Gothic Goth,
Grantha Gran,Greek Grek,Gujarati Gujr,Gunjala_Gondi Gong,Gurmukhi Guru,
Gurung_Khema Gukh,Han Hani,Hangul Hang,Hanifi_Rohingya Rohg,Hanunoo Hano,
Hatran Hatr,Hebrew Hebr,Hiragana Hira,Imperial_Aramaic Armi,Inherited Zinh,
Inscriptional_Pahlavi Phli,Inscriptional_Parthian Prti,Javanese Java,
Kaithi Kthi,Kannada Knda,Katakana Kana,Kawi Kawi,Kayah_Li Kali,
Kharoshthi Khar,Khitan_Small_Script Kits,Khmer Khmr,Khojki Khoj,
Khudawadi Sind,Kirat_Rai Krai,Lao Laoo,Latin Latn,Lepcha Lepc,Limbu Limb,
Linear_A Lina,Linear_B Linb,Lisu Lisu,Lycian Lyci,Lydian Lydi,Mahajani Mahj,
Makasar Maka,Malayalam Mlym,Mandaic Mand,Manichaean Mani,Marchen Marc,
Masaram_Gondi Gonm,Medefaidrin Medf,Meetei_Mayek Mtei,Mende_Kikakui Mend,
Meroitic_Cursive Merc,Meroitic_Hieroglyphs Mero,Miao Plrd,Modi Modi,
Mongolian Mong,Mro Mroo,Multani Mult,Myanmar Mymr,Nabataean Nbat,
Nag_Mundari Nagm,Nandinagari Nand,New_Tai_Lue Talu,Newa Newa,Nko Nkoo,
Nushu Nshu,Nyiakeng_Puachue_Hmong Hmnp,Ogham Ogam,Ol_Chiki Olck,Ol_Onal Onao,
Old_Hungarian Hung,Old_Italic Ital,Old_North_Arabian Narb,Old_Permic Perm,
Old_Persian Xpeo,Old_Sogdian Sogo,Old_South_Arabian Sarb,Old_Turkic Orkh,
Old_Uyghur Ougr,Oriya Orya,Osage Osge,Osmanya Osma,Pahawh_Hmong Hmng,
Palmyrene Palm,Pau_Cin_Hau Pauc,Phags_Pa Phag,Phoenician Phnx,
Psalter_Pahlavi Phlp,Rejang Rjng,Runic Runr,Samaritan Samr,Saurashtra Saur,
Sharada Shrd,Shavian Shaw,Siddham Sidd,Sidetic Sidt,SignWriting Sgnw,
Sinhala Sinh,Sogdian Sogd,Sora_Sompeng Sora,Soyombo Soyo,Sundanese Sund,
Sunuwar Sunu,Syloti_Nagri Sylo,Syriac Syrc,Tagalog Tglg,Tagbanwa Tagb,
Tai_Le Tale,Tai_Tham Lana,Tai_Viet Tavt,Tai_Yo Tayo,Takri Takr,Tamil Taml,
Tangsa Tnsa,Tangut Tang,Telugu Telu,Thaana Thaa,Thai Thai,Tibetan Tibt,
Tifinagh Tfng,Tirhuta Tirh,Todhri Todr,Tolong_Siki Tols,Toto Toto,
Tulu_Tigalari Tutg,Ugaritic Ugar,Unknown Zzzz,Vai Vaii,Vithkuqi Vith,
Wancho Wcho,Warang_Citi Wara,Yezidi Yezi,Yi Yiii,Zanabazar_Square Zanb`
    .split(",")
    .map((pair): [string, string] => {
      const [name = "", code = ""] = pair.trim().split(" ");
      return [name, code];
    })
);

const CATEGORY_CODES: Readonly<Record<string, string>> = {
  Close_Punctuation: "Pe",
  Connector_Punctuation: "Pc",
  Control: "Cc",
  Currency_Symbol: "Sc",
  Dash_Punctuation: "Pd",
  Decimal_Number: "Nd",
  Enclosing_Mark: "Me",
  Final_Punctuation: "Pf",
  Format: "Cf",
  Initial_Punctuation: "Pi",
  Letter_Number: "Nl",
  Line_Separator: "Zl",
  Lowercase_Letter: "Ll",
  Math_Symbol: "Sm",
  Modifier_Letter: "Lm",
  Modifier_Symbol: "Sk",
  Nonspacing_Mark: "Mn",
  Open_Punctuation: "Ps",
  Other_Letter: "Lo",
  Other_Number: "No",
  Other_Punctuation: "Po",
  Other_Symbol: "So",
  Paragraph_Separator: "Zp",
  Private_Use: "Co",
  Space_Separator: "Zs",
  Spacing_Mark: "Mc",
  Surrogate: "Cs",
  Titlecase_Letter: "Lt",
  Unassigned: "Cn",
  Uppercase_Letter: "Lu",
};

interface CodePointRange {
  /** First code point. */
  readonly begin: number;
  /** One past the last code point. */
  readonly end: number;
}

const require = createRequire(import.meta.url);
const outDir = path.join(import.meta.dirname, "../src/unicode/data");

const unicodeDir = path.dirname(
  require.resolve("@unicode/unicode-17.0.0/index.mjs")
);
const ENCODED_RANGES = /decodeRanges\('([^']*)'\)/;

const fail = (message: string): never => {
  throw new Error(message);
};

/**
 * Reads a property value's ranges from the package file itself. Importing
 * these files through a computed `import()` is not safe on Bun 1.3: it has
 * returned another file's ranges (Block/Tags came back as Duployan).
 */
const loadRanges = async (
  property: string,
  value: string
): Promise<readonly CodePointRange[]> => {
  const source = await readFile(
    path.join(unicodeDir, property, value, "ranges.mjs"),
    "utf8"
  );
  const encoded = ENCODED_RANGES.exec(source)?.[1];
  return encoded === undefined
    ? fail(`Cannot read the ranges of ${property}=${value}.`)
    : decodeRanges(encoded);
};

// Scripts

const scriptOf = new Array<string>(MAX_CODE_POINT + 1).fill(UNKNOWN_SCRIPT);
const scriptRows: string[] = [];

/** A script reads right to left when most of its strong characters do. */
const directionOf = (ranges: readonly CodePointRange[]) => {
  let rightToLeft = 0;
  let leftToRight = 0;
  for (const range of ranges) {
    for (let codePoint = range.begin; codePoint < range.end; codePoint += 1) {
      const bidi = bidiClasses.get(codePoint);
      if (bidi === "Right_To_Left" || bidi === "Arabic_Letter") {
        rightToLeft += 1;
      } else if (bidi === "Left_To_Right") {
        leftToRight += 1;
      }
    }
  }
  return rightToLeft > leftToRight ? "r" : "l";
};

/** Checks a code against the runtime's own Unicode data, where it knows the script. */
const verifyCode = (name: string, code: string, sample: number) => {
  let pattern: RegExp;
  try {
    pattern = new RegExp(`\\p{Script=${code}}`, "u");
  } catch {
    return;
  }
  if (!pattern.test(String.fromCodePoint(sample))) {
    fail(`ISO 15924 code ${code} does not name the script ${name}.`);
  }
};

for (const name of [...unicode.Script].sort()) {
  const code = ISO_15924.get(name) ?? fail(`No ISO 15924 code for ${name}.`);
  const ranges = await loadRanges("Script", name);
  for (const range of ranges) {
    scriptOf.fill(code, range.begin, range.end);
  }
  if (code !== UNKNOWN_SCRIPT) {
    verifyCode(name, code, ranges[0]?.begin ?? fail(`${name} is empty.`));
    scriptRows.push(
      `${code}|${name.replaceAll("_", " ")}|${directionOf(ranges)}`
    );
  }
}
if (new Set(ISO_15924.values()).size !== unicode.Script.length) {
  fail("The ISO 15924 table and the Unicode script list disagree.");
}

// Property runs

const categoryOf = (codePoint: number) => {
  const name = generalCategories.get(codePoint) ?? "Unassigned";
  return CATEGORY_CODES[name] ?? fail(`Unknown general category ${name}.`);
};

/** Runs over the whole code space: a base 36 length (left out when 1), then the value. */
const encodeRuns = (propertyOf: (codePoint: number) => string) => {
  let encoded = "";
  let start = 0;
  let current = propertyOf(0);
  for (let codePoint = 1; codePoint <= MAX_CODE_POINT + 1; codePoint += 1) {
    const value = codePoint <= MAX_CODE_POINT ? propertyOf(codePoint) : "";
    if (value !== current) {
      const length = codePoint - start;
      encoded += `${length === 1 ? "" : length.toString(RADIX)}${current}`;
      start = codePoint;
      current = value;
    }
  }
  return encoded;
};

// Blocks

const HYPHENATED_SUFFIX = / (Extended|Forms|Area|Symbols|Arrows) ([A-Z])$/;

const blockName = (value: string) =>
  value
    .replaceAll("_", " ")
    .replace(" And ", " and ")
    .replace(" For ", " for ")
    .replace(HYPHENATED_SUFFIX, " $1-$2")
    .replace("Latin 1 ", "Latin-1 ")
    .replace("Phags Pa", "Phags-pa");

interface BlockRange {
  readonly first: number;
  readonly last: number;
  readonly name: string;
}

const blocks: BlockRange[] = [];
for (const value of unicode.Block) {
  if (value !== "No_Block") {
    const [range, ...rest] = await loadRanges("Block", value);
    if (!range || rest.length > 0) {
      fail(`Block ${value} is not one range.`);
    } else {
      blocks.push({
        first: range.begin,
        last: range.end - 1,
        name: blockName(value),
      });
    }
  }
}
blocks.sort((a, b) => a.first - b.first);
for (const [index, block] of blocks.entries()) {
  if (block.first <= (blocks[index - 1]?.last ?? -1)) {
    fail(`Block ${block.name} overlaps the block before it.`);
  }
}

// Names

const namedEntries = [...unicodeNames].sort((a, b) => a[0] - b[0]);
const nameRules: NameRule[] = [];
const listedNames: [number, string][] = [];

for (const [codePoint, name] of namedEntries) {
  if (isHangulSyllable(codePoint)) {
    if (hangulSyllableName(codePoint) !== name) {
      fail(
        `The Hangul rule gives the wrong name for ${codePointDigits(codePoint)}.`
      );
    }
    continue;
  }
  const suffix = `-${codePointDigits(codePoint)}`;
  if (!name.endsWith(suffix)) {
    listedNames.push([codePoint, name]);
    continue;
  }
  const prefix = name.slice(0, -suffix.length + 1);
  const open = nameRules.at(-1);
  if (open && open.prefix === prefix && open.last === codePoint - 1) {
    nameRules[nameRules.length - 1] = { ...open, last: codePoint };
  } else {
    nameRules.push({ first: codePoint, last: codePoint, prefix });
  }
}

/** Groups listed names into chunks that end on block boundaries. */
const nameChunks = (() => {
  const chunks: [number, string][][] = [];
  let chunk: [number, string][] = [];
  let bytes = 0;
  let index = 0;
  for (const block of blocks) {
    const inBlock: [number, string][] = [];
    while (
      (listedNames[index]?.[0] ?? Number.POSITIVE_INFINITY) <= block.last
    ) {
      const entry = listedNames[index];
      if (entry) {
        inBlock.push(entry);
      }
      index += 1;
    }
    const size = encodeNames(inBlock).length;
    if (chunk.length > 0 && bytes + size > NAME_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(...inBlock);
    bytes += size;
  }
  if (index !== listedNames.length) {
    fail("A named character lies outside every block.");
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
})();

// Languages

const REGION = /^([A-Z]{2}|\d{3})$/;
const localesDir = path.join(
  path.dirname(require.resolve("cldr-misc-modern/package.json")),
  "main"
);
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

interface CharactersFile {
  readonly main: Record<
    string,
    {
      readonly characters: {
        readonly auxiliary: string;
        readonly exemplarCharacters: string;
      };
    }
  >;
}

/** Exemplars are lower case; a language needs the capitals as well. */
const withCapitals = (codePoints: readonly number[]) => {
  const all = new Set(codePoints);
  for (const codePoint of codePoints) {
    const capital = uppercase.get(codePoint);
    if (capital !== undefined) {
      all.add(capital);
    }
  }
  return [...all].sort((a, b) => a - b);
};

const SHARED_SCRIPTS = new Set(["Zyyy", "Zinh", UNKNOWN_SCRIPT]);

/** The script most of the required characters belong to. */
const mainScript = (codePoints: readonly number[]) => {
  const counts = new Map<string, number>();
  for (const codePoint of codePoints) {
    const script = scriptOf[codePoint] ?? UNKNOWN_SCRIPT;
    if (!SHARED_SCRIPTS.has(script)) {
      counts.set(script, (counts.get(script) ?? 0) + 1);
    }
  }
  const ranked = [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  return ranked[0]?.[0];
};

interface LanguageRow {
  readonly auxiliary: string;
  readonly required: string;
  readonly script: string;
  readonly tag: string;
}

const readLanguage = async (tag: string): Promise<LanguageRow | undefined> => {
  const file: CharactersFile = JSON.parse(
    await readFile(path.join(localesDir, tag, "characters.json"), "utf8")
  );
  const characters = file.main[tag]?.characters;
  if (!characters) {
    return fail(`${tag} has no characters.`);
  }
  const required = withCapitals(
    expandExemplarSet(characters.exemplarCharacters)
  );
  const script = mainScript(required);
  if (!script) {
    return;
  }
  const needed = new Set(required);
  const auxiliary = withCapitals(expandExemplarSet(characters.auxiliary));
  return {
    auxiliary: encodeCodePoints(
      auxiliary.filter((codePoint) => !needed.has(codePoint))
    ),
    required: encodeCodePoints(required),
    script,
    tag,
  };
};

const languages = new Map<string, LanguageRow>();
for (const tag of (await readdir(localesDir)).sort()) {
  const regional = tag.split("-").some((subtag) => REGION.test(subtag));
  const language = regional ? undefined : await readLanguage(tag);
  if (language) {
    languages.set(tag, language);
  }
}

/** A locale that repeats its parent, such as az-Latn after az, adds nothing. */
const repeatsParent = (language: LanguageRow) => {
  const parent = languages.get(language.tag.split("-").slice(0, -1).join("-"));
  return (
    parent?.required === language.required &&
    parent.auxiliary === language.auxiliary
  );
};

const languageRows = [...languages.values()]
  .filter((language) => !repeatsParent(language))
  .map((language) =>
    [
      language.tag,
      languageNames.of(language.tag) ?? language.tag,
      language.script,
      language.required,
      language.auxiliary,
    ].join("|")
  );

// Output

const HEADER = `/**
 * Generated by scripts/build-unicode-data.ts from @unicode/unicode-17.0.0 and
 * cldr-misc-modern. Do not edit: change the script and run it again.
 */
`;

const constant = (name: string, value: string) => {
  const literal = JSON.stringify(value);
  const oneLine = `export const ${name} = ${literal};`;
  return oneLine.length <= LINE_WIDTH
    ? `${oneLine}\n`
    : `export const ${name} =\n  ${literal};\n`;
};

const chunkFile = (index: number) =>
  `names-${index.toString().padStart(2, "0")}`;

const files = new Map<string, string>([
  [
    "properties.ts",
    [
      HEADER,
      constant("SCRIPTS", scriptRows.join(";")),
      constant(
        "SCRIPT_RUNS",
        encodeRuns((codePoint) => scriptOf[codePoint] ?? UNKNOWN_SCRIPT)
      ),
      constant("CATEGORY_RUNS", encodeRuns(categoryOf)),
      constant(
        "BLOCKS",
        blocks
          .map(
            (block) =>
              `${block.first.toString(RADIX)}|${block.last.toString(RADIX)}|${block.name}`
          )
          .join(";")
      ),
      constant(
        "NAME_RULES",
        nameRules
          .map(
            (rule) =>
              `${rule.first.toString(RADIX)}|${rule.last.toString(RADIX)}|${rule.prefix}`
          )
          .join(";")
      ),
    ].join("\n"),
  ],
  [
    "name-chunks.ts",
    [
      HEADER,
      "/** The first named code point of each chunk, in base 36. */",
      constant(
        "NAME_CHUNK_STARTS",
        nameChunks
          .map((chunk) => (chunk[0]?.[0] ?? 0).toString(RADIX))
          .join(",")
      ),
      `export const NAME_CHUNK_LOADERS = [\n${nameChunks
        .map((_, index) => `  () => import("./${chunkFile(index)}"),\n`)
        .join("")}];\n`,
    ].join("\n"),
  ],
  [
    "languages.ts",
    `${HEADER}\n${constant("LANGUAGES", languageRows.join(";"))}`,
  ],
  ...nameChunks.map((chunk, index): [string, string] => [
    `${chunkFile(index)}.ts`,
    `${HEADER}\n${constant("NAMES", encodeNames(chunk))}`,
  ]),
]);

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });
for (const [name, content] of files) {
  await writeFile(path.join(outDir, name), content);
  console.log(`${Buffer.byteLength(content).toString().padStart(8)}  ${name}`);
}
