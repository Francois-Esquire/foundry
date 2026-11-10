import "./reconstruct.css";
import { useEffect } from "react";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { RuledSection } from "~/ui/layout/ruled-section";
import { CompletionSection } from "./completion-section";
import { BasisLegend, DestinationSection } from "./destination-section";
import { EvidenceSection } from "./evidence-section";
import { IsolationSection } from "./isolation-section";
import { LettersSection } from "./letters-section";
import { OutlinesSection } from "./outlines-section";
import { RegionSection } from "./region-section";
import { DESTINATION_GONE, destinationStands } from "./session";
import {
  usePhotograph,
  useProject,
  useReconstructSession,
  useReconstructState,
} from "./use-session";

/**
 * Reconstruct: recover a typeface from a photograph of lettering. Evidence
 * comes in, a region is marked, its lettering is isolated and read, outlines
 * are traced and checked against the photograph, and the letters go to a
 * face as candidates. What the photograph does not show can then be inferred,
 * and is marked as inferred everywhere.
 */
export default function ReconstructScreen() {
  const session = useReconstructSession();
  const state = useReconstructState(session);
  const project = useProject();
  const photograph = usePhotograph(state.evidence);
  const { evidence, proposal, reading } = state;

  // Fonts imported since the last visit are faces to read against.
  useEffect(() => {
    session.refresh();
  }, [session]);

  const working = state.working ? (
    <ProgressLine label="Reading the lettering" />
  ) : null;
  const unread = state.readingProblem ? (
    <Notice tone="problem">{state.readingProblem}</Notice>
  ) : null;

  return (
    <div className="ty-reconstruct">
      <RuledSection
        first
        heading="Evidence"
        lede="Bring in a photograph of lettering. It is evidence: it is kept exactly as it is, and nothing leaves this machine."
      >
        <EvidenceSection session={session} state={state} />
      </RuledSection>
      {evidence && photograph ? (
        <>
          <RuledSection
            heading="Region"
            lede="Mark where the lettering is. A rectangle when it is seen head on, four corners when it is seen at an angle."
          >
            <RegionSection
              photograph={photograph}
              session={session}
              state={state}
            />
            {working}
            {unread}
          </RuledSection>
          <RuledSection
            heading="Isolation"
            lede="The lettering is told from its ground by colour or by tone. Change how, and the result follows."
          >
            {state.region ? (
              <IsolationSection session={session} state={state} />
            ) : (
              <p>Mark a region above to see its lettering isolated.</p>
            )}
          </RuledSection>
          <RuledSection
            heading="Letters"
            lede="Each letter found, boxed on the photograph, with the character it is taken for."
          >
            {reading ? (
              <LettersSection
                photograph={photograph}
                reading={reading}
                session={session}
                state={state}
              />
            ) : (
              <p>Letters appear here once a region is marked.</p>
            )}
          </RuledSection>
          <RuledSection
            heading="Outlines"
            lede="The outline traced from each labelled letter, laid over the photograph, with how well it fits."
          >
            {reading ? (
              <OutlinesSection photograph={photograph} reading={reading} />
            ) : (
              <p>Outlines appear here once letters are found and labelled.</p>
            )}
          </RuledSection>
          <RuledSection
            heading="Candidates"
            lede="Choose the face the letters go to. They arrive as candidates: accept or reject each, then refine it in the Studio."
          >
            <BasisLegend />
            {reading ? (
              <DestinationSection
                project={project}
                reading={reading}
                session={session}
                state={state}
              />
            ) : (
              <p>Letters can be proposed once they are found and labelled.</p>
            )}
          </RuledSection>
          <RuledSection
            heading="Completion"
            lede="Ask a generation strategy for the characters the photograph does not show. Everything it draws is inferred, and marked so."
          >
            {proposal && !destinationStands(proposal, project) ? (
              <p data-destination="gone">{DESTINATION_GONE}</p>
            ) : null}
            {proposal && destinationStands(proposal, project) ? (
              <CompletionSection
                evidence={evidence}
                project={project}
                proposal={proposal}
                session={session}
                state={state}
              />
            ) : null}
            {proposal ? null : (
              <p>
                Propose the observed letters to a face first. The missing
                characters are then inferred for that face, in its style.
              </p>
            )}
          </RuledSection>
        </>
      ) : null}
    </div>
  );
}
