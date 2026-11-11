import { describe, expect, it } from "vitest";
import {
  runVariableBuild,
  type VariableRunDependencies,
  type VariableStep,
} from "~/export/variable/variable-run";
import {
  createVariableSession,
  isOutdated,
  type VariableBasis,
} from "~/export/variable/variable-session";
import {
  BuildError,
  type BuiltVariableFont,
  type ValidationReport,
  type VariableBuildRequest,
} from "~/packaging/building";
import { emptyProject } from "~/typeface/project";

const BYTES = new Uint8Array([0, 1, 0, 0]);

const BUILT: BuiltVariableFont = {
  axis: { default: 400, max: 800, min: 300, name: "Weight", tag: "wght" },
  bytes: BYTES,
  characterCount: 612,
  glyphCount: 960,
  notes: ["Values between two masters are interpolated in a straight line."],
  timings: {
    checkMs: 76,
    mastersMs: 7199,
    mergeMs: 5205,
    saveMs: 2350,
    totalMs: 14_830,
  },
};

const SOUND: ValidationReport = {
  characterCount: 612,
  glyphCount: 960,
  issues: [],
  loadable: true,
};

const master = (styleName: string, weight: number) => ({
  added: [],
  featureCode: [],
  location: { wght: weight },
  overrides: new Map(),
  styleName,
});

const REQUEST: VariableBuildRequest = {
  faceIndex: 0,
  familyName: "Atlas Sans",
  masters: [master("Light", 300), master("ExtraBold", 800)],
  source: BYTES,
};

const dependencies = (
  changes: Partial<VariableRunDependencies> = {}
): VariableRunDependencies => ({
  browserCheck: () => Promise.resolve(),
  builder: {
    buildVariable: () => Promise.resolve(BUILT),
    validate: () => Promise.resolve(SOUND),
  },
  now: () => "2026-11-10T09:00:00.000Z",
  ...changes,
});

const build = async (changes: Partial<VariableRunDependencies> = {}) => {
  const steps: VariableStep[] = [];
  const outcome = await runVariableBuild(
    REQUEST,
    "AtlasSans-Variable.ttf",
    dependencies(changes),
    (step) => steps.push(step)
  );
  return { outcome, steps };
};

describe("building and checking a variable font", () => {
  it("reports each step, and holds the two checks that ran and no other", async () => {
    const ranges: string[] = [];
    const { outcome, steps } = await build({
      browserCheck: (_font, range) => {
        ranges.push(range);
        return Promise.resolve();
      },
    });
    expect(steps).toEqual(["building", "checking", "loading"]);
    if (outcome.status !== "built") {
      throw new Error("The font was not built.");
    }
    // The browser is told the weight range, or it takes the font for one weight.
    expect(ranges).toEqual(["300 800"]);
    expect(outcome.font).toMatchObject({
      axis: BUILT.axis,
      builtAt: "2026-11-10T09:00:00.000Z",
      bytes: BYTES,
      fileName: "AtlasSans-Variable.ttf",
      masters: ["Light", "ExtraBold"],
      notes: BUILT.notes,
      timings: BUILT.timings,
    });
    expect(outcome.font.checks).toEqual([
      {
        details: [],
        id: "engine",
        message:
          "The font engine reads every table and saves the font again without errors: 960 glyphs, 612 characters.",
        outcome: "pass",
      },
      {
        details: [],
        id: "browser",
        message:
          "The browser loads the font as a variable font, weight 300 to 800.",
        outcome: "pass",
      },
    ]);
  });

  it("fails the engine check with every issue the engine found", async () => {
    const { outcome } = await build({
      builder: {
        buildVariable: () => Promise.resolve(BUILT),
        validate: () =>
          Promise.resolve({
            ...SOUND,
            issues: [
              { message: "The gvar table is damaged.", severity: "error" },
            ],
            loadable: false,
          }),
      },
    });
    expect(outcome.status === "built" && outcome.font.checks[0]).toEqual({
      details: ["The gvar table is damaged."],
      id: "engine",
      message: "The font engine found errors in the font.",
      outcome: "fail",
    });
  });

  it("fails the engine check when the engine cannot check at all", async () => {
    const { outcome } = await build({
      builder: {
        buildVariable: () => Promise.resolve(BUILT),
        validate: () => Promise.reject(new BuildError("The engine stopped.")),
      },
    });
    expect(
      outcome.status === "built" && outcome.font.checks.map((c) => c.outcome)
    ).toEqual(["fail", "pass"]);
    expect(outcome.status === "built" && outcome.font.checks[0]?.message).toBe(
      "The font engine could not check the font: The engine stopped."
    );
  });

  it("fails the browser check with the browser's reason", async () => {
    const { outcome } = await build({
      browserCheck: () => Promise.reject(new Error("OTS parsing error")),
    });
    expect(outcome.status === "built" && outcome.font.checks[1]).toEqual({
      details: [],
      id: "browser",
      message: "The browser does not load the font: OTS parsing error",
      outcome: "fail",
    });
  });

  it("says the browser check did not run when there is no browser", async () => {
    const { outcome } = await build({ browserCheck: undefined });
    expect(outcome.status === "built" && outcome.font.checks[1]?.outcome).toBe(
      "not-run"
    );
  });

  it("gives the engine's reason when it refuses the masters, and checks nothing", async () => {
    const refusal =
      "The glyph a cannot interpolate: it has 2 contours in the Light master and 1 in the Bold master.";
    const { outcome, steps } = await build({
      builder: {
        buildVariable: () => Promise.reject(new BuildError(refusal)),
        validate: () => Promise.reject(new Error("It must not be called.")),
      },
    });
    expect(steps).toEqual(["building"]);
    expect(outcome).toEqual({ message: refusal, status: "failed" });
  });
});

describe("the variable font session", () => {
  const basis: VariableBasis = {
    fileName: "AtlasSans-Variable.ttf",
    groupKey: "face",
    masterIds: ["light", "heavy"],
    project: emptyProject(),
  };

  /** The browser loads the font. */
  const loads = () => Promise.resolve();

  it("exports as static fonts until a variable font is chosen", () => {
    const session = createVariableSession(dependencies());
    expect(session.getState()).toEqual({ excluded: [], ways: {} });
    session.setWay("face", "variable");
    expect(session.getState().ways).toEqual({ face: "variable" });
  });

  it("leaves a pinned instance out of the masters and puts it back", () => {
    const session = createVariableSession(dependencies());
    session.setMaster("medium", false);
    session.setMaster("medium", false);
    expect(session.getState().excluded).toEqual(["medium"]);
    session.setMaster("medium", true);
    expect(session.getState().excluded).toEqual([]);
  });

  it("shows each step of a build, keeps the result, and tells listeners", async () => {
    const session = createVariableSession(dependencies());
    const seen: string[] = [];
    const stop = session.subscribe(() => {
      const { run } = session.getState();
      seen.push(run?.status === "running" ? run.step : (run?.status ?? ""));
    });
    await session.build(basis, REQUEST, loads);
    stop();
    expect(seen).toEqual(["building", "checking", "loading", "built"]);
    const { run } = session.getState();
    expect(run?.basis).toBe(basis);
    expect(run?.status === "built" && run.font.fileName).toBe(
      "AtlasSans-Variable.ttf"
    );
  });

  it("starts no second build while one is running", async () => {
    let builds = 0;
    let finish: (font: BuiltVariableFont) => void = () => undefined;
    const slow = dependencies({
      builder: {
        buildVariable: () => {
          builds += 1;
          return new Promise<BuiltVariableFont>((resolve) => {
            finish = resolve;
          });
        },
        validate: () => Promise.resolve(SOUND),
      },
    });
    const session = createVariableSession(slow);
    const first = session.build(basis, REQUEST, loads);
    await session.build(basis, REQUEST, loads);
    expect(builds).toBe(1);
    finish(BUILT);
    await first;
    expect(session.getState().run?.status).toBe("built");
  });

  it("keeps a refused build with the engine's reason", async () => {
    const session = createVariableSession(
      dependencies({
        builder: {
          buildVariable: () => Promise.reject(new BuildError("Refused.")),
          validate: () => Promise.resolve(SOUND),
        },
      })
    );
    await session.build(basis, REQUEST, loads);
    expect(session.getState().run).toEqual({
      basis,
      message: "Refused.",
      status: "failed",
    });
  });

  it("knows when the project, the masters or the file has changed since a build", async () => {
    const session = createVariableSession(dependencies());
    await session.build(basis, REQUEST, loads);
    const { run } = session.getState();
    if (!run) {
      throw new Error("Nothing was built.");
    }
    expect(isOutdated(run, { ...basis })).toBe(false);
    expect(isOutdated(run, { ...basis, project: emptyProject() })).toBe(true);
    expect(isOutdated(run, { ...basis, masterIds: ["light"] })).toBe(true);
    expect(isOutdated(run, { ...basis, fileName: "Other-Variable.ttf" })).toBe(
      true
    );
  });
});
