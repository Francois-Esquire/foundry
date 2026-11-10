/**
 * Runs the Python font engine on a Pyodide runtime the caller has loaded.
 * The same host serves the browser worker and Node.
 */
import type { PyodideInterface } from "pyodide";
import {
  BuildError,
  type BuildRequest,
  type BuiltFont,
  type FontBuilder,
  type LayoutSummary,
  type ValidationReport,
} from "../building";
import engineSource from "./engine.py?raw";

export const ENGINE_PACKAGES = ["fonttools", "brotli"];

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

const serialise = (request: BuildRequest) =>
  JSON.stringify({
    added: request.added.map(({ name, outline, advance, characters }) => ({
      advance,
      characters,
      name,
      outline,
    })),
    faceIndex: request.faceIndex,
    familyName: request.familyName,
    featureCode: request.featureCode,
    flavor: request.flavor,
    location: request.location,
    overrides: [...request.overrides.entries()],
    subset: request.subset,
  });

/** Loads the engine code into the runtime and returns a font builder backed by it. */
export const createFontBuilder = async (
  py: PyodideInterface
): Promise<FontBuilder> => {
  await py.loadPackage(ENGINE_PACKAGES, { messageCallback: () => undefined });
  py.runPython(engineSource);
  py.FS.mkdirTree(WORK_DIR);
  const entry = (name: string): Entry => py.globals.get(name) as Entry;
  const build = entry("build");
  const describeLayout = entry("describe_layout");
  const validate = entry("validate");
  let counter = 0;

  /** Writes input bytes, runs one engine call, and always removes its files. */
  const withFile = <T>(
    bytes: Uint8Array,
    run: (input: string, output: string) => T
  ): T => {
    counter += 1;
    const input = `${WORK_DIR}/in-${counter}`;
    const output = `${WORK_DIR}/out-${counter}`;
    py.FS.writeFile(input, bytes);
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

  return {
    async build(request) {
      return withFile(request.source, (input, output) => {
        const report = parse<Omit<BuiltFont, "bytes">>(
          build(serialise(request), input, output)
        );
        return { ...report, bytes: py.FS.readFile(output) as Uint8Array };
      });
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
