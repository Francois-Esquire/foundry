/**
 * The Typography command line: one command a call, on a project kept in a
 * directory. It parses its arguments, runs the command, saves the project,
 * and prints one JSON document. A command that refuses prints its reason on
 * stderr and exits with 1. Font bytes are never printed: `export --out`
 * writes the files and prints where.
 *
 *   bun scripts/typography.ts import      --project <dir> <file>...
 *   bun scripts/typography.ts inspect     --project <dir>
 *   bun scripts/typography.ts generate    --project <dir> --face <face> --script-extension devanagari-subset --recorded <run dir>
 *   bun scripts/typography.ts generate    --project <dir> --face <face> --recorded <run dir> [--output <label>]
 *   bun scripts/typography.ts generate    --project <dir> --face <face> --characters "é è ñ" --strategy procedural
 *   bun scripts/typography.ts reconstruct --project <dir> --photograph <artifact> --region x,y,width,height --text "NEEDED THINGS" --text "FOR SALE" --family <name> [--complete-recorded <run dir>]
 *   bun scripts/typography.ts accept      --project <dir> (--run <id> | --candidates <id>,<id> | --all | --passed)
 *   bun scripts/typography.ts export      --project <dir> --face <face> --family <name> [--out <dir>]
 *   bun scripts/typography.ts render      --project <dir> --font <artifact> --text <text> [--out <file.svg>]
 *
 * <face> is a face id or its label, such as "Lato Regular". A model strategy
 * (image-model, vector-model) needs FAL_API_KEY in the environment and makes
 * a paid call.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Application } from "~/application/application";
import type {
  AcceptRequest,
  CandidateRunRequest,
} from "~/application/commands";
import { openNodeApplication } from "~/application/node";
import { Refusal } from "~/application/refusal";

const USAGE =
  "Usage: bun scripts/typography.ts <import|inspect|generate|reconstruct|accept|export|render> --project <dir> [options]. The top of scripts/typography.ts lists each command's options.";

const STRATEGIES = ["image-model", "procedural", "vector-model"] as const;

const parsed = () =>
  parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      all: { type: "boolean" },
      candidates: { type: "string" },
      characters: { type: "string" },
      "complete-recorded": { type: "string" },
      face: { multiple: true, type: "string" },
      family: { type: "string" },
      font: { type: "string" },
      out: { type: "string" },
      output: { type: "string" },
      passed: { type: "boolean" },
      photograph: { type: "string" },
      project: { type: "string" },
      recorded: { type: "string" },
      region: { type: "string" },
      run: { type: "string" },
      "script-extension": { type: "string" },
      strategy: { type: "string" },
      text: { multiple: true, type: "string" },
    },
  });

type Options = ReturnType<typeof parsed>["values"];

/** The value of an option a command cannot run without. */
const needed = (value: string | undefined, option: string): string => {
  if (value === undefined) {
    throw new Refusal(`This command needs --${option}. ${USAGE}`);
  }
  return value;
};

const generate = (app: Application, options: Options) => {
  const faceId = needed(options.face?.[0], "face");
  if (options["script-extension"] !== undefined) {
    return app.generate({
      faceId,
      kind: "script-extension",
      plan: options["script-extension"],
      recordedRun: needed(options.recorded, "recorded"),
    });
  }
  if (options.recorded !== undefined) {
    return app.generate({
      faceId,
      kind: "recorded",
      output: options.output,
      recordedRun: options.recorded,
    });
  }
  const strategy = STRATEGIES.find((kind) => kind === options.strategy);
  if (!strategy) {
    throw new Refusal(
      `--strategy is one of ${STRATEGIES.join(", ")}, to generate --characters with.`
    );
  }
  const request: CandidateRunRequest = {
    characters: needed(options.characters, "characters"),
    faceId,
    kind: "characters",
    strategy,
  };
  return app.generate(request);
};

const reconstruct = (app: Application, options: Options) => {
  const [x, y, width, height] = needed(options.region, "region")
    .split(",")
    .map(Number);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    [x, y, width, height].some(Number.isNaN)
  ) {
    throw new Refusal("--region is four numbers: x,y,width,height.");
  }
  return app.reconstruct({
    complete:
      options["complete-recorded"] === undefined
        ? undefined
        : { kind: "recorded", recordedRun: options["complete-recorded"] },
    destination: { familyName: needed(options.family, "family"), kind: "new" },
    photograph: needed(options.photograph, "photograph"),
    region: { height, width, x, y },
    text: options.text,
  });
};

const acceptRequest = (options: Options): AcceptRequest => {
  if (options.run !== undefined) {
    return { run: options.run };
  }
  if (options.candidates !== undefined) {
    return { candidates: options.candidates.split(",").filter(Boolean) };
  }
  if (options.all) {
    return { candidates: "all" };
  }
  if (options.passed) {
    return { candidates: "passed" };
  }
  throw new Refusal(
    "Say what to accept: --run <id>, --candidates <id>,<id>, --all or --passed."
  );
};

/** Exports, and writes the files when a directory is given. Bytes are never printed. */
const exportFonts = async (app: Application, options: Options) => {
  const exported = await app.export({
    faces: options.face ?? [],
    familyName: options.family,
  });
  if (exported.fonts.length === 0 && exported.problems.length > 0) {
    throw new Refusal(exported.problems.join(" "));
  }
  if (options.out !== undefined && exported.fonts.length > 0) {
    mkdirSync(options.out, { recursive: true });
  }
  return {
    ...exported,
    fonts: exported.fonts.map(({ bytes, ...font }) => {
      if (options.out === undefined) {
        return font;
      }
      const file = path.join(options.out, font.fileName);
      writeFileSync(file, bytes);
      return { ...font, path: file };
    }),
  };
};

/** Renders, and writes the picture when a file is given. */
const render = async (app: Application, options: Options) => {
  const { svg, ...picture } = await app.render({
    font: { artifactId: needed(options.font, "font") },
    text: needed(options.text?.[0], "text"),
  });
  if (options.out === undefined) {
    return { ...picture, svg };
  }
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, svg);
  return { ...picture, path: options.out };
};

const run = (
  app: Application,
  command: string | undefined,
  files: readonly string[],
  options: Options
): unknown => {
  switch (command) {
    case "import":
      return app.import(
        files.map((file) => ({
          bytes: new Uint8Array(readFileSync(file)),
          name: path.basename(file),
        }))
      );
    case "inspect":
      return app.inspect();
    case "generate":
      return generate(app, options);
    case "reconstruct":
      return reconstruct(app, options);
    case "accept":
      return app.accept(acceptRequest(options));
    case "export":
      return exportFonts(app, options);
    case "render":
      return render(app, options);
    default:
      throw new Refusal(USAGE);
  }
};

const main = async () => {
  const { positionals, values } = parsed();
  const [command, ...files] = positionals;
  const app = await openNodeApplication({
    directory: needed(values.project, "project"),
    providerKey: process.env.FAL_API_KEY,
  });
  try {
    const result = await run(app, command, files, values);
    await app.save();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
};

/** An option the command line does not know is the caller's mistake, not a fault. */
const isUsageError = (error: unknown): error is Error =>
  error instanceof Error &&
  "code" in error &&
  String(error.code).startsWith("ERR_PARSE_ARGS");

try {
  await main();
} catch (error) {
  if (!(error instanceof Refusal || isUsageError(error))) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
