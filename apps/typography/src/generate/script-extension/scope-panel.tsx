import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";
import type { Face } from "~/typeface/face";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { Mark } from "~/ui/symbols/mark";
import type { FaceStanding } from "./face-standing";
import { scopeOf, scopeStatement } from "./scope";
import { GENERATE_HASH } from "./script-extension-address";

interface ScopePanelProps {
  readonly face: Face;
  readonly plan: ScriptExtensionPlan;
  readonly standing: FaceStanding;
}

function Standing({ face, standing }: Omit<ScopePanelProps, "plan">) {
  const name = face.description.fullName;
  if (standing.kind === "not-offered") {
    return <Notice>{standing.reason}</Notice>;
  }
  return standing.kind === "in-face" ? (
    <Mark kind="revisions">The extension is in {name} as one revision.</Mark>
  ) : (
    <Mark kind="missing">
      Missing. {name} has none of the plan's characters.
    </Mark>
  );
}

/** The scope in words before anything runs, and where the face stands with it. */
export function ScopePanel({ face, plan, standing }: ScopePanelProps) {
  const scope = scopeOf(plan);
  return (
    <div className="ty-generate-stack">
      <div className="ty-generate-actions">
        <ButtonLink href={GENERATE_HASH} symbol="chevron-left">
          Back to Generate
        </ButtonLink>
      </div>
      <p className="ty-lede" data-extension-scope="">
        {scopeStatement(plan)}
      </p>
      <TitleBlock>
        <TitleBlockItem label="Face" weight={2}>
          {face.description.fullName}
        </TitleBlockItem>
        <TitleBlockItem label="Script" weight={2}>
          {scope.script}, a defined subset
        </TitleBlockItem>
        <TitleBlockItem label="Characters">{scope.characters}</TitleBlockItem>
        <TitleBlockItem label="Forms with no character">
          {scope.forms}
        </TitleBlockItem>
        <TitleBlockItem label="Test words">{scope.words}</TitleBlockItem>
        <TitleBlockItem label="In the face now" weight={2}>
          <span data-characters-in-face={standing.held}>
            {standing.held} of {scope.characters} characters
          </span>
        </TitleBlockItem>
      </TitleBlock>
      <Standing face={face} standing={standing} />
    </div>
  );
}
