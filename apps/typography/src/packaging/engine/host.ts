/**
 * Runs the Python font engine on a Pyodide runtime the caller has loaded.
 * The same host serves the browser worker and Node.
 */
import type { PyodideInterface } from "pyodide";
import type { AddedGlyph, GlyphOverride } from "~/typeface/changes";
import {
  BuildError,
  type BuildRequest,
  type BuiltFont,
  type BuiltVariableFont,
  type FontBuilder,
  type LayoutSummary,
  type ValidationReport,
  type VariableBuildRequest,
} from "../building";
import engineSource from "./engine.py?raw";

const ENGINE_PACKAGES = ["fonttools", "brotli"];

const WORK_DIR = "/work";

type Entry = (...args: (string | number)[]) => string;

/** Engine calls answer with JSON. A failure arrives as { error }. */
const parse = <T>(json: string): T => {
  const result = JSON.parse(json) as T | { error: string };
  if (result && typeof result === "object" && "error" in result) {
    throw new BuildError(result.error);
  }
  return result as T;
};

/** What the engine needs of a working face. Keys and provenance stay in the project. */
const glyphChanges = (changes: {
  readonly added: readonly AddedGlyph[];
  readonly overrides: ReadonlyMap<number, GlyphOverride>;
}) => ({
  added: changes.added.map(({ name, outline, advance, characters }) => ({
    advance,
    characters,
    name,
    outline,
  })),
  overrides: [...changes.overrides.entries()],
});

const serialise = (request: BuildRequest) =>
  JSON.stringify({
    ...glyphChanges(request),
    faceIndex: request.faceIndex,
    familyName: request.familyName,
    featureCode: request.featureCode,
    flavor: request.flavor,
    location: request.location,
    styleName: request.styleName,
    subset: request.subset,
  });

const serialiseVariable = (request: VariableBuildRequest) =>
  JSON.stringify({
    faceIndex: request.faceIndex,
    familyName: request.familyName,
    flavor: request.flavor,
    masters: request.masters.map((master) => ({
      ...glyphChanges(master),
      featureCode: master.featureCode,
      location: master.location,
      styleName: master.styleName,
    })),
  });

/** Loads the engine code into the runtime and returns a font builder backed by it. */
export const createFontBuilder = async (
  py: PyodideInterface
): Promise<FontBuilder> => {
  await py.loadPackage(ENGINE_PACKAGES, { messageCallback: () => undefined });
  py.runPython(engineSource);
  py.FS.mkdirTree(WORK_DIR);
  const entry = (name: string): Entry => py.globals.get(name) as Entry;
  const blankFont = entry("blank_font");
  const build = entry("build");
  const buildVariable = entry("build_variable");
  const describeLayout = entry("describe_layout");
  const validate = entry("validate");
  let counter = 0;

  /** Writes any input bytes, runs one engine call, and always removes its files. */
  const withFile = <T>(
    bytes: Uint8Array | undefined,
    run: (input: string, output: string) => T
  ): T => {
    counter += 1;
    const input = `${WORK_DIR}/in-${counter}`;
    const output = `${WORK_DIR}/out-${counter}`;
    if (bytes) {
      py.FS.writeFile(input, bytes);
    }
    try {
      return run(input, output);
    } finally {
      for (const file of [input, output]) {
        if (py.FS.analyzePath(file).exists) {
          py.FS.unlink(file);
        }
      }
    }
  };

  /** Runs a call that writes a font, and returns its report with the bytes. */
  const built = <Report>(
    source: Uint8Array | undefined,
    call: (input: string, output: string) => string
  ) =>
    withFile(source, (input, output) => ({
      ...parse<Report>(call(input, output)),
      bytes: py.FS.readFile(output) as Uint8Array,
    }));

  return {
    async blankFont(request) {
      return built<Omit<BuiltFont, "bytes">>(undefined, (_, output) =>
        blankFont(JSON.stringify(request), output)
      );
    },
    async build(request) {
      return built<Omit<BuiltFont, "bytes">>(request.source, (input, output) =>
        build(serialise(request), input, output)
      );
    },
    async buildVariable(request) {
      return built<Omit<BuiltVariableFont, "bytes">>(
        request.source,
        (input, output) =>
          buildVariable(serialiseVariable(request), input, output)
      );
    },
    async describeLayout(font, faceIndex = 0) {
      return withFile(font, (input) =>
        parse<LayoutSummary>(describeLayout(input, faceIndex))
      );
    },
    async validate(font) {
      return withFile(font, (input) =>
        parse<ValidationReport>(validate(input))
      );
    },
  };
};
