import type { Check } from "~/packaging/validation";
/**
 * Builds one variable font and checks it the two ways a rebuilt variable
 * font is checked: by the engine that built it, and by loading it in the
 * browser. Each step is reported as it starts. Nothing else is checked, and
 * the result says so by holding only the checks that ran.
 */

import { reasonOf } from "~/lib/reason";
import type {
  BuiltVariableFont,
  FontBuilder,
  VariableBuildRequest,
} from "~/packaging/building";

type VariableCheckId = "browser" | "engine";

type VariableCheck = Check<VariableCheckId>;

/** A variable font built in this session. */
export interface BuiltVariable {
  readonly axis: BuiltVariableFont["axis"];
  readonly builtAt: string;
  readonly bytes: Uint8Array;
  readonly characterCount: number;
  readonly checks: readonly VariableCheck[];
  readonly fileName: string;
  readonly glyphCount: number;
  /** The style names of the masters, as the request listed them. */
  readonly masters: readonly string[];
  /** Notes from the engine, as it wrote them. */
  readonly notes: readonly string[];
  readonly timings: BuiltVariableFont["timings"];
}

export type VariableStep = "building" | "checking" | "loading";

export type VariableOutcome =
  | { readonly status: "built"; readonly font: BuiltVariable }
  /** The message names the problem as the engine reported it. */
  | { readonly status: "failed"; readonly message: string };

export interface VariableRunDependencies {
  /**
   * Rejects when the browser will not load the font. A variable font needs
   * its weight range, or the browser takes it for one weight. Left out, the
   * check is not run.
   */
  readonly browserCheck?: (
    font: Uint8Array,
    weightRange: string
  ) => Promise<unknown>;
  readonly builder: Pick<FontBuilder, "buildVariable" | "validate">;
  /** Says when the font was built. */
  readonly clock: () => Date;
}

const checkEngine = async (
  builder: VariableRunDependencies["builder"],
  font: Uint8Array
): Promise<VariableCheck> => {
  try {
    const report = await builder.validate(font);
    const details = report.issues.map((issue) => issue.message);
    return report.loadable
      ? {
          details,
          id: "engine",
          message: `The font engine reads every table and saves the font again without errors: ${report.glyphCount} glyphs, ${report.characterCount} characters.`,
          outcome: "pass",
        }
      : {
          details,
          id: "engine",
          message: "The font engine found errors in the font.",
          outcome: "fail",
        };
  } catch (error) {
    return {
      details: [],
      id: "engine",
      message: `The font engine could not check the font: ${reasonOf(error)}`,
      outcome: "fail",
    };
  }
};

const checkBrowser = async (
  browserCheck: VariableRunDependencies["browserCheck"],
  font: Uint8Array,
  { max, min }: BuiltVariableFont["axis"]
): Promise<VariableCheck> => {
  if (!browserCheck) {
    return {
      details: [],
      id: "browser",
      message: "No browser check was supplied.",
      outcome: "not-run",
    };
  }
  try {
    await browserCheck(font, `${min} ${max}`);
    return {
      details: [],
      id: "browser",
      message: `The browser loads the font as a variable font, weight ${min} to ${max}.`,
      outcome: "pass",
    };
  } catch (error) {
    return {
      details: [],
      id: "browser",
      message: `The browser does not load the font: ${reasonOf(error)}`,
      outcome: "fail",
    };
  }
};

/** Builds, then checks. A build the engine refuses is a failure with the engine's reason. */
export const runVariableBuild = async (
  request: VariableBuildRequest,
  fileName: string,
  { browserCheck, builder, clock }: VariableRunDependencies,
  onStep: (step: VariableStep) => void
): Promise<VariableOutcome> => {
  onStep("building");
  let built: BuiltVariableFont;
  try {
    built = await builder.buildVariable(request);
  } catch (error) {
    return { message: reasonOf(error), status: "failed" };
  }
  onStep("checking");
  const engine = await checkEngine(builder, built.bytes);
  onStep("loading");
  const browser = await checkBrowser(browserCheck, built.bytes, built.axis);
  return {
    font: {
      axis: built.axis,
      builtAt: clock().toISOString(),
      bytes: built.bytes,
      characterCount: built.characterCount,
      checks: [engine, browser],
      fileName,
      glyphCount: built.glyphCount,
      masters: request.masters.map((master) => master.styleName),
      notes: built.notes,
      timings: built.timings,
    },
    status: "built",
  };
};
