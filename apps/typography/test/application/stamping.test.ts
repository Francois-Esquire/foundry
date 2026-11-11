/** The builder the application hands out gives every build the application's clock time. */
import { describe, expect, it } from "vitest";
import { stamping } from "~/application/stamping";
import type {
  BlankFontRequest,
  BuildRequest,
  FontBuilder,
  VariableBuildRequest,
} from "~/packaging/building";
import { EMPTY_WORKING_FACE, glyphChangesOf } from "~/typeface/changes";
import { testApplication } from "../helpers/application";
import { FIXED_TIME, fixedClock } from "../helpers/fixed";
import { fixtureFile, importOne } from "../helpers/workspace";

const EARLIER = "2026-01-01T00:00:00.000Z";

const REQUEST: BuildRequest = {
  ...glyphChangesOf(EMPTY_WORKING_FACE),
  faceIndex: 0,
  source: Uint8Array.of(0, 1, 0, 0),
};

const VARIABLE: VariableBuildRequest = {
  faceIndex: 0,
  masters: [],
  source: REQUEST.source,
};

/** A builder that keeps what it was asked and builds nothing. */
const recordingBuilder = () => {
  const asked: { readonly call: string; readonly request: unknown }[] = [];
  const answer = (call: string) => (request: unknown) => {
    asked.push({ call, request });
    return Promise.reject(new Error("This builder builds nothing."));
  };
  const builder: FontBuilder = {
    blankFont: answer("blankFont"),
    build: answer("build"),
    buildVariable: answer("buildVariable"),
    describeLayout: answer("describeLayout"),
    validate: answer("validate"),
  };
  return { asked, builder };
};

/** Calls a builder that always rejects, and lets the rejection go. */
const ask = (call: Promise<unknown>) => call.catch(() => undefined);

describe("the stamping builder", () => {
  it("gives a build and a variable build the clock's time as their modified time", async () => {
    const { asked, builder } = recordingBuilder();
    const stamped = stamping(builder, fixedClock);
    await ask(stamped.build(REQUEST));
    await ask(stamped.buildVariable(VARIABLE));
    expect(asked).toEqual([
      { call: "build", request: { ...REQUEST, modifiedAt: FIXED_TIME } },
      {
        call: "buildVariable",
        request: { ...VARIABLE, modifiedAt: FIXED_TIME },
      },
    ]);
  });

  it("reads the clock at each build, and leaves a time the caller gave", async () => {
    const { asked, builder } = recordingBuilder();
    let time = FIXED_TIME;
    const stamped = stamping(builder, () => new Date(time));
    await ask(stamped.build(REQUEST));
    time = "2026-11-10T09:00:07.000Z";
    await ask(stamped.build(REQUEST));
    await ask(stamped.build({ ...REQUEST, modifiedAt: EARLIER }));
    expect(
      asked.map(({ request }) => (request as BuildRequest).modifiedAt)
    ).toEqual([FIXED_TIME, "2026-11-10T09:00:07.000Z", EARLIER]);
  });

  it("passes a blank font, a layout read and a validation through untouched", async () => {
    const { asked, builder } = recordingBuilder();
    const stamped = stamping(builder, fixedClock);
    const blank: BlankFontRequest = {
      familyName: "Needed Things",
      metrics: { ascender: 800, descender: -200, lineGap: 0, unitsPerEm: 1000 },
      styleName: "Regular",
    };
    const font = Uint8Array.of(1, 2, 3);
    await ask(stamped.blankFont(blank));
    await ask(stamped.describeLayout(font, 0));
    await ask(stamped.validate(font));
    expect(asked.map(({ request }) => request)).toEqual([blank, font, font]);
  });
});

describe("an application's builder", () => {
  it("stamps the working build of Proof, which asks for no time itself", async () => {
    const { asked, builder } = recordingBuilder();
    const application = await testApplication({ builder });
    const { faceId } = await importOne(
      application.workspace,
      fixtureFile("lato")
    );
    application.places.proof.start(faceId, "Lato Regular");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      call: "build",
      request: { modifiedAt: FIXED_TIME },
    });
  });
});
