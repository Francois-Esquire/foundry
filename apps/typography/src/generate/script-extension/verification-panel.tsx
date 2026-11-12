import type { MadeExtension } from "~/generation/script-extension/extend";
import type { WorkingFace } from "~/typeface/changes";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { useEngineStatus } from "~/workspace/services";
import type { VerifyState } from "./session";
import { VerificationReportView } from "./verification-report-view";

interface VerificationPanelProps {
  readonly findings: MadeExtension;
  /** True while the extension's revision is applied. */
  readonly inFace: boolean;
  readonly onVerify: () => void;
  /** The face's units per em, which the built font keeps. */
  readonly unitsPerEm: number;
  readonly verification: VerifyState;
  /** The face's applied changes as the project has them now. */
  readonly working: WorkingFace;
}

/**
 * Builds the face through the font engine and shows what was checked in the
 * built font. The report always belongs to the face as it was built: once
 * the face moves on, the panel says so.
 */
export function VerificationPanel({
  findings,
  inFace,
  onVerify,
  unitsPerEm,
  verification,
  working,
}: VerificationPanelProps) {
  const engine = useEngineStatus();
  const running = verification.status === "running";
  const verified =
    verification.status === "finished" ? verification.verified : undefined;
  return (
    <div className="ty-generate-stack">
      <div className="ty-generate-actions">
        <Button
          disabled={running || !inFace}
          onClick={onVerify}
          variant="solid"
        >
          {verified ? "Build and verify again" : "Build and verify"}
        </Button>
        {inFace || running ? null : (
          <span className="ty-generate-reason">
            Add the extension to the face first. Verification builds the face as
            the project has it, and the extension is not in it.
          </span>
        )}
      </div>
      {running ? (
        <ProgressLine
          label={
            engine === "starting"
              ? "Starting the font engine"
              : "Building the face and checking the extension in it"
          }
        />
      ) : null}
      {verification.status === "failed" ? (
        <Notice tone="problem">
          The verification did not finish, so nothing was verified.{" "}
          {verification.reason} Build and verify again.
        </Notice>
      ) : null}
      {verified && verified.working !== working ? (
        <Notice>
          The face has changed since this font was built. The report below
          describes the face as it was then, not as it is now.{" "}
          {inFace
            ? "Build and verify again to check it as it is."
            : "The extension is no longer in the face."}
        </Notice>
      ) : null}
      {verified ? (
        <VerificationReportView
          extension={findings}
          unitsPerEm={unitsPerEm}
          verified={verified}
        />
      ) : null}
    </div>
  );
}
