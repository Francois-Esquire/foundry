/**
 * The script extension's session: the recorded run it replays from, and for
 * each face the run, its result and its verification. The result is not
 * part of the project until it is added, and the screen is taken down
 * whenever a person looks at another place, so it is remembered here.
 * Whether the extension is in a face is never remembered: it is read from
 * the project.
 */

import type { ImageCodec } from "~/generation/raster/image-codec";
import {
  extendScript,
  type ScriptExtension,
} from "~/generation/script-extension/extend";
import { describeVerification } from "~/generation/script-extension/verification-report";
import {
  type VerificationReport,
  verifyExtension,
} from "~/generation/script-extension/verify";
import { count } from "~/lib/count";
import { reasonOf } from "~/lib/reason";
import { createStore } from "~/lib/store";
import type { FontBuilder } from "~/packaging/building";
import { derivedFamilyName } from "~/packaging/licence";
import type { WorkingFace } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import { findFace, findSource } from "~/typeface/project";
import type { FontReader } from "~/typeface/reading";
import type { Workspace } from "~/workspace/workspace";
import {
  type Fetch,
  listRecordedRuns,
  type RecordedEntry,
} from "../recorded-catalogue";
import { addExtension } from "./adding";
import { extensionInFace } from "./face-standing";
import type { ExtensionOffering } from "./offering";
import {
  absenceReason,
  entriesFor,
  extensionSheets,
  type LoadedSheet,
  loadSheets,
} from "./recorded-sheets";
import { listUnder, NOT_VERIFIED_HEADING } from "./report-sections";
import { type SetLine, setLine } from "./set-line";

/** The recorded run the extension replays from, once it has been listed. */
export type SourceState =
  | { readonly status: "idle" | "listing" }
  | { readonly status: "failed"; readonly reason: string }
  | {
      readonly status: "listed";
      /** One entry per sheet. Never empty. */
      readonly entries: readonly RecordedEntry[];
    };

export interface RunStep {
  /** What the step did, or why it failed. */
  readonly detail?: string;
  readonly elapsedMs?: number;
  readonly id: string;
  readonly label: string;
  readonly status: "failed" | "finished" | "running" | "waiting";
}

export type RunState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly steps: readonly RunStep[] }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly steps: readonly RunStep[];
    }
  | {
      readonly status: "finished";
      readonly extension: ScriptExtension;
      readonly steps: readonly RunStep[];
    };

/** A verification as the screen shows it. Plain data: the built font is closed. */
export interface VerifiedExtension {
  /** The family name the font was built under for the checks. */
  readonly familyName: string;
  /** A Latin sample from the same built font, to compare size and weight with. */
  readonly latin: SetLine;
  /** The report's own list of what was not verified, as written there. */
  readonly notVerified: readonly string[];
  readonly report: VerificationReport;
  /** The source's reserved font name, when it was left out of that name. */
  readonly withheldName?: string;
  /** Each test word set in the built font's own outlines, in plan order. */
  readonly words: readonly SetLine[];
  /** The working face that was built. A face that has moved on is no longer this font. */
  readonly working: WorkingFace;
}

export type VerifyState =
  | { readonly status: "idle" | "running" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "finished"; readonly verified: VerifiedExtension };

export interface FaceState {
  /** Why the project refused the extension, when it did. */
  readonly refusal?: string;
  readonly run: RunState;
  readonly verification: VerifyState;
}

export interface ScriptExtensionState {
  readonly faces: ReadonlyMap<FaceId, FaceState>;
  readonly source: SourceState;
}

export interface SessionMeans {
  /** Where the app is served from, ending in a slash. */
  readonly base: string;
  /** Builds the face a verification checks, and validates it. */
  readonly builder: Pick<FontBuilder, "build" | "validate">;
  /** Says when each sheet's run started and ended. */
  readonly clock: () => Date;
  readonly codec: Pick<ImageCodec, "decode">;
  /** Fetches the recorded runs served with the app. */
  readonly fetch: Fetch;
  readonly newId: () => string;
  readonly offering: ExtensionOffering;
  /** Reopens the built face for a verification. */
  readonly reader: FontReader;
  /** Milliseconds since any fixed moment, for timing the steps of a run. */
  readonly timer: () => number;
  readonly workspace: Workspace;
}

export interface ScriptExtensionSession {
  /** Adds the whole extension to the face as one revision. A refusal is kept in the face's state. */
  add(faceId: FaceId): void;
  getState(): ScriptExtensionState;
  /** Finds the recorded run. Does nothing once it is listed. */
  listSource(): Promise<void>;
  readonly offering: ExtensionOffering;
  /** Replays the recorded run for a face. Never rejects: a failure is in the face's state. */
  run(faceId: FaceId): Promise<void>;
  subscribe(listener: () => void): () => void;
  /** Builds the face and checks the extension in it. Never rejects. */
  verify(faceId: FaceId): Promise<void>;
}

const IDLE_FACE: FaceState = {
  run: { status: "idle" },
  verification: { status: "idle" },
};

export const faceStateOf = (
  state: ScriptExtensionState,
  faceId: FaceId
): FaceState => state.faces.get(faceId) ?? IDLE_FACE;

/** The keys of the glyphs a face's finished run made. Empty before one has finished. */
export const extensionKeysOf = ({ run }: FaceState): readonly string[] =>
  run.status === "finished"
    ? run.extension.glyphs.map((glyph) => glyph.key)
    : [];

const FETCH_STEP = "fetch";
const SETTLE_STEP = "settle";
const LATIN_SAMPLE = "Hamburg";

const sheetStep = (label: string) => `sheet:${label}`;

/** Lets the browser draw the steps so far before the next piece of work. */
const pause = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const firstSteps = (entries: readonly RecordedEntry[]): RunStep[] => [
  {
    id: FETCH_STEP,
    label: "Fetch the recorded sheets",
    status: "running",
  },
  ...entries.map(
    (entry): RunStep => ({
      id: sheetStep(entry.output.name ?? entry.output.strategy),
      label: `Read the ${entry.output.name ?? entry.output.strategy} sheet`,
      status: "waiting",
    })
  ),
  {
    id: SETTLE_STEP,
    label: "Settle spacing, anchors and layout rules",
    status: "waiting",
  },
];

/** What a sheet came to: the glyphs made from it, and the cells set aside. */
const sheetDetail = (
  { runId }: LoadedSheet,
  { glyphs, runs }: ScriptExtension
): string => {
  const made = glyphs.filter(
    ({ provenance }) =>
      provenance.origin === "generated" && provenance.runId === runId
  ).length;
  const extra =
    runs.find((run) => run.record.runId === runId)?.artefacts.extraction?.report
      .extra.length ?? 0;
  return `${count(made, "glyph")} made.${extra > 0 ? ` ${count(extra, "cell")} the plan does not list ${extra === 1 ? "was" : "were"} set aside.` : ""}`;
};

export const createScriptExtensionSession = (
  means: SessionMeans
): ScriptExtensionSession => {
  const { offering, timer, workspace } = means;
  const { plan } = offering;
  const store = createStore<ScriptExtensionState>({
    faces: new Map(),
    source: { status: "idle" },
  });

  const setState = store.patch;

  const faceOf = (faceId: FaceId) => faceStateOf(store.getState(), faceId);

  const setFace = (faceId: FaceId, patch: Partial<FaceState>) =>
    setState({
      faces: new Map(store.getState().faces).set(faceId, {
        ...faceOf(faceId),
        ...patch,
      }),
    });

  const inFace = (faceId: FaceId) =>
    extensionInFace(
      extensionKeysOf(faceOf(faceId)),
      workspace.workingFace(faceId)
    );

  /** A face of the plan's script from the project, to tell letters apart with. */
  const referenceFor = (faceId: FaceId) => {
    const letters = plan.glyphs
      .filter((glyph) => glyph.rule.kind === "base")
      .flatMap((glyph) => glyph.characters);
    for (const other of workspace.getState().project.faces) {
      const face = workspace.openFace(other.id);
      if (
        other.id !== faceId &&
        letters.length > 0 &&
        letters.every(
          (character) => face.glyphForCharacter(character) !== undefined
        )
      ) {
        return { face, name: other.description.familyName };
      }
    }
  };

  const replay = async (
    faceId: FaceId,
    entries: readonly RecordedEntry[]
  ): Promise<void> => {
    let steps = firstSteps(entries);
    let started = timer();
    const show = () => setFace(faceId, { run: { status: "running", steps } });
    /** Ends the step under way, with what it came to, and starts the next one. */
    const advance = (nextId: string, detail?: string) => {
      steps = steps.map((step): RunStep => {
        if (step.status === "running") {
          return {
            ...step,
            detail: detail ?? step.detail,
            elapsedMs: timer() - started,
            status: "finished",
          };
        }
        return step.id === nextId ? { ...step, status: "running" } : step;
      });
      started = timer();
    };
    setFace(faceId, {
      refusal: undefined,
      run: { status: "running", steps },
      verification: { status: "idle" },
    });
    try {
      const sheets = await loadSheets(means.fetch, means.base, entries);
      // Only the fetch has something to say for itself when it ends. A sheet's
      // own figures are known once the whole extension has been made.
      let fetched: string | undefined =
        `${count(sheets.length, "sheet")} fetched.`;
      const extension = await extendScript({
        clock: means.clock,
        codec: means.codec,
        face: workspace.openFace(faceId),
        faceId,
        newId: means.newId,
        plan,
        sheets: extensionSheets(sheets, plan, async (sheet) => {
          advance(sheetStep(sheet.label), fetched);
          fetched = undefined;
          show();
          await pause();
        }),
      });
      advance(SETTLE_STEP);
      steps = steps.map((step): RunStep => {
        const sheet = sheets.find(
          (loaded) => sheetStep(loaded.label) === step.id
        );
        if (sheet) {
          return { ...step, detail: sheetDetail(sheet, extension) };
        }
        return step.id === SETTLE_STEP
          ? {
              ...step,
              detail: `${count(extension.glyphs.length, "glyph")} settled, ${extension.missing.length} not made.`,
              status: "finished",
            }
          : step;
      });
      setFace(faceId, { run: { extension, status: "finished", steps } });
    } catch (error) {
      const reason = reasonOf(error);
      setFace(faceId, {
        run: {
          reason,
          status: "failed",
          steps: steps.map(
            (step): RunStep =>
              step.status === "running"
                ? { ...step, detail: reason, status: "failed" }
                : step
          ),
        },
      });
    }
  };

  const check = async (
    faceId: FaceId,
    extension: ScriptExtension
  ): Promise<VerifiedExtension> => {
    const { project } = workspace.getState();
    const face = findFace(project, faceId);
    const source = findSource(project, face.sourceId);
    const working = workspace.workingFace(faceId);
    const { familyName, withheld } = derivedFamilyName(
      face.description,
      `${plan.script} Subset`
    );
    const verification = await verifyExtension({
      builder: means.builder,
      extension,
      familyName,
      reader: means.reader,
      reference: referenceFor(faceId),
      source: { bytes: source.bytes, faceIndex: face.index },
      working,
    });
    const { derived, report } = verification;
    try {
      const firstAdded = workspace.openFace(faceId).description.glyphCount;
      return {
        familyName,
        latin: setLine(derived, LATIN_SAMPLE, { firstAdded }),
        notVerified: listUnder(
          describeVerification(extension, report),
          NOT_VERIFIED_HEADING
        ),
        report,
        withheldName: withheld,
        words: plan.words.map((word) =>
          setLine(derived, word.text, { firstAdded, script: plan.iso15924 })
        ),
        working,
      };
    } finally {
      derived.close();
    }
  };

  return {
    add(faceId) {
      const { run } = faceOf(faceId);
      if (run.status !== "finished" || inFace(faceId)) {
        return;
      }
      const outcome = addExtension(
        workspace,
        plan.script,
        run.extension.changes
      );
      setFace(faceId, {
        refusal: outcome.ok ? undefined : outcome.notice.message,
      });
    },
    getState: store.getState,
    async listSource() {
      if (
        store.getState().source.status === "listing" ||
        store.getState().source.status === "listed"
      ) {
        return;
      }
      setState({ source: { status: "listing" } });
      try {
        const catalogue = await listRecordedRuns(means.fetch, means.base);
        const entries = entriesFor(catalogue, offering);
        setState({
          source:
            entries.length > 0
              ? { entries, status: "listed" }
              : {
                  reason: absenceReason(catalogue, offering),
                  status: "failed",
                },
        });
      } catch (error) {
        setState({ source: { reason: reasonOf(error), status: "failed" } });
      }
    },
    offering,
    async run(faceId) {
      const { source } = store.getState();
      if (
        source.status !== "listed" ||
        faceOf(faceId).run.status === "running" ||
        faceOf(faceId).verification.status === "running" ||
        inFace(faceId)
      ) {
        return;
      }
      await replay(faceId, source.entries);
    },
    subscribe: store.subscribe,
    async verify(faceId) {
      const { run, verification } = faceOf(faceId);
      if (
        run.status !== "finished" ||
        verification.status === "running" ||
        !inFace(faceId)
      ) {
        return;
      }
      setFace(faceId, { verification: { status: "running" } });
      try {
        const verified = await check(faceId, run.extension);
        setFace(faceId, { verification: { status: "finished", verified } });
      } catch (error) {
        setFace(faceId, {
          verification: { reason: reasonOf(error), status: "failed" },
        });
      }
    },
  };
};
