/**
 * The command that runs the independent validator, `scripts/validate-font.py`,
 * on a downloaded font. The screen prints it and the end-to-end test runs
 * the same arguments, so what is shown is what was proved to work.
 */
import { formatCodePoint } from "~/unicode/code-point";

export interface ValidatorRun {
  /** Characters the font has to map. Left out, the character map is not checked. */
  readonly characters?: readonly number[];
  /** Where the downloaded font is. */
  readonly fontPath: string;
  /** A text to shape with native HarfBuzz. */
  readonly shape?: string;
}

/** The program to start. Its arguments come from `validatorArguments`. */
export const VALIDATOR_PROGRAM = "uv";

/** Where to run the command from: the directory that holds `scripts/`. */
export const VALIDATOR_DIRECTORY = "apps/typography";

const TOOLS = ["fonttools", "opentype-sanitizer", "uharfbuzz"];

export const validatorArguments = ({
  characters,
  fontPath,
  shape,
}: ValidatorRun): string[] => [
  "run",
  "--no-project",
  ...TOOLS.flatMap((tool) => ["--with", tool]),
  "python",
  "-I",
  "scripts/validate-font.py",
  fontPath,
  ...(characters && characters.length > 0
    ? ["--expect-chars", characters.map(formatCodePoint).join(",")]
    : []),
  ...(shape ? ["--shape", shape] : []),
];

const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/** Quotes one argument for a POSIX shell. */
const quoted = (argument: string) =>
  PLAIN_WORD.test(argument)
    ? argument
    : `'${argument.replaceAll("'", "'\\''")}'`;

/** The whole command as one line for a POSIX shell. */
export const validatorCommand = (run: ValidatorRun): string =>
  [VALIDATOR_PROGRAM, ...validatorArguments(run)].map(quoted).join(" ");
