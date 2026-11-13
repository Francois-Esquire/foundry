import "./script-extension.css";
import { useCallback, useEffect } from "react";
import { exportFaceHash } from "~/export/export-address";
import { subjectAddress } from "~/proof/proof-address";
import type { Face } from "~/typeface/face";
import { ButtonLink } from "~/ui/controls/button";
import { RuledSection } from "~/ui/layout/ruled-section";
import { AddPanel } from "./add-panel";
import { ExtensionRunPanel } from "./extension-run-panel";
import { NotesPanel } from "./notes-panel";
import { PlanTables } from "./plan-tables";
import { ResultBoard } from "./result-board";
import { scopeStatement } from "./scope";
import { ScopePanel } from "./scope-panel";
import {
  useFaceStanding,
  useFaceState,
  useScriptExtensionSession,
  useSourceState,
  useWorkingFace,
} from "./use-script-extension";
import { VerificationPanel } from "./verification-panel";

interface ScriptExtensionPlaceProps {
  readonly face: Face;
}

/**
 * The script extension for one face, below the Generate place: the scope
 * and the plan, the replay of the recorded run, the result to look at, the
 * one action that adds it whole, and its verification in a built font.
 */
export function ScriptExtensionPlace({ face }: ScriptExtensionPlaceProps) {
  const session = useScriptExtensionSession();
  const standing = useFaceStanding(session, face);
  const { refusal, run, verification } = useFaceState(session, face);
  const source = useSourceState(session);
  const working = useWorkingFace(face);
  const { plan } = session.offering;
  const name = face.description.fullName;

  useEffect(() => {
    session.listSource();
  }, [session]);

  const replay = useCallback(() => {
    session.run(face.id);
  }, [face.id, session]);
  const add = useCallback(() => session.add(face.id), [face.id, session]);
  const verify = useCallback(() => {
    session.verify(face.id);
  }, [face.id, session]);

  const displayed = session.shown(face.id);
  const shown = displayed?.shown;
  const findings = displayed?.findings;
  const inFace = standing.kind === "in-face";
  return (
    <>
      <RuledSection
        first
        heading="Script extension"
        lede={`Add a defined part of another script to ${name}: its glyphs and the layout rules they need, as one revision.`}
      >
        <ScopePanel face={face} plan={plan} standing={standing} />
      </RuledSection>
      <RuledSection
        heading="Plan"
        lede="Each glyph the extension makes, with its character or the rule that reaches it, and the words that prove the rules work."
      >
        <PlanTables faceName={name} plan={plan} />
      </RuledSection>
      <RuledSection
        heading="Run"
        lede="The glyphs come from a recorded run: saved model output, replayed here without calling a model."
      >
        <ExtensionRunPanel
          face={face}
          onListAgain={session.listSource}
          onRun={replay}
          run={run}
          source={source}
          standing={standing}
        />
      </RuledSection>
      {shown ? (
        <>
          <RuledSection
            heading="Result"
            lede="Every glyph the run made, to look at before anything enters the face."
          >
            {findings ? null : (
              <p className="ty-extension-measure">
                This page holds no findings for these glyphs. What the making
                found of each glyph, its notes and its sheets are not kept with
                the project.
              </p>
            )}
            <ResultBoard
              face={face}
              findings={findings}
              inFace={inFace}
              shown={shown}
            />
          </RuledSection>
          {findings ? (
            <RuledSection
              heading="Notes"
              lede="How the new letters were sized, how their weight compares with the face's, and what the run reported."
            >
              <NotesPanel findings={findings} />
            </RuledSection>
          ) : null}
          <RuledSection
            heading="Add to the face"
            lede={
              inFace
                ? "One action, one revision. The extension is in the face."
                : "One action, one revision. Nothing above has changed the face yet."
            }
          >
            <AddPanel
              face={face}
              findings={findings}
              onAdd={add}
              refusal={refusal}
              shown={shown}
              standing={standing}
            />
          </RuledSection>
          {findings ? (
            <RuledSection
              heading="Verification"
              lede="Build the face through the font engine and check, in the built font, what the plan promises."
            >
              <VerificationPanel
                findings={findings}
                inFace={inFace}
                onVerify={verify}
                unitsPerEm={face.description.metrics.unitsPerEm}
                verification={verification}
                working={working}
              />
            </RuledSection>
          ) : (
            <RuledSection heading="Verification">
              <p className="ty-extension-measure">
                Verification reads where the marks attach, which the making
                found and the project does not keep. To verify this extension,
                undo it and make it again on this page.
              </p>
            </RuledSection>
          )}
          <RuledSection
            heading="Next"
            lede="Proof sets the plan's test words in the built face. Export builds a derived font under a new family name."
          >
            {inFace ? (
              <div className="ty-generate-stack">
                <div className="ty-generate-actions">
                  <ButtonLink
                    href={subjectAddress(
                      { faceId: face.id, kind: "face" },
                      plan.words.map((word) => word.text).join(" ")
                    )}
                  >
                    Prove {name}
                  </ButtonLink>
                  <ButtonLink href={exportFaceHash(face.id)}>
                    Plan an export
                  </ButtonLink>
                </div>
                <p className="ty-extension-measure">
                  Neither place makes the scope wider. {scopeStatement(plan)}
                </p>
              </div>
            ) : (
              <p className="ty-extension-measure">
                Proof and Export work on the face as the project has it. Add the
                extension to the face, then go on from here.
              </p>
            )}
          </RuledSection>
        </>
      ) : null}
    </>
  );
}
