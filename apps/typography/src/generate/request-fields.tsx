import { useCallback, useMemo } from "react";
import { type Face, faceListLabel, isEditable } from "~/typeface/face";
import { families } from "~/typeface/project";
import { Segmented } from "~/ui/controls/segmented";
import { Select } from "~/ui/controls/select";
import { TextField } from "~/ui/controls/text-field";
import type { Language } from "~/unicode/languages";
import { useProject, useWorkspace } from "~/workspace/react";
import { canCoordinate } from "./family/weights";
import { scopeOptions } from "./missing-characters";
import type { Draft, TargetSource } from "./session";

const SOURCES: readonly {
  readonly label: string;
  readonly value: TargetSource;
}[] = [
  { label: "Typed list", value: "typed" },
  { label: "Writing system", value: "script" },
  { label: "Language", value: "language" },
];

const SCOPE_OPTIONS = scopeOptions();
const NO_LANGUAGE = { label: "Choose a language", value: "" };

const optionLabel = (face: Face) => {
  if (isEditable(face)) {
    return faceListLabel(face);
  }
  return canCoordinate(face)
    ? `${faceListLabel(face)}, variable: generates across weights`
    : `${faceListLabel(face)}, variable: pin an instance to edit it`;
};

interface RequestFieldsProps {
  readonly draft: Draft;
  readonly face: Face;
  /** Undefined while the language data loads. */
  readonly languages: readonly Language[] | undefined;
  readonly onDraft: (patch: Partial<Draft>) => void;
  /** A recorded run draws what it drew, so the choice of characters is off. */
  readonly replaying: boolean;
}

/** The face to generate for and where the characters come from. */
export function RequestFields({
  draft,
  face,
  languages,
  onDraft,
  replaying,
}: RequestFieldsProps) {
  const workspace = useWorkspace();
  const project = useProject();
  const faces = useMemo(
    () =>
      families(project).flatMap((family) =>
        family.faces.map((member) => ({
          disabled: !(isEditable(member) || canCoordinate(member)),
          label: optionLabel(member),
          value: member.id,
        }))
      ),
    [project]
  );
  const languageOptions = useMemo(
    () => [
      NO_LANGUAGE,
      ...(languages ?? [])
        .map((language) => ({
          label: `${language.name} (${language.tag})`,
          value: language.tag,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "en")),
    ],
    [languages]
  );
  const chooseFace = useCallback(
    (faceId: string) => {
      workspace.setActiveFace(faceId);
    },
    [workspace]
  );
  const chooseSource = useCallback(
    (source: TargetSource) => onDraft({ source }),
    [onDraft]
  );
  const chooseScope = useCallback(
    (scope: string) => onDraft({ scope }),
    [onDraft]
  );
  const chooseLanguage = useCallback(
    (language: string) => onDraft({ language }),
    [onDraft]
  );
  const type = useCallback(
    (event: { readonly currentTarget: HTMLInputElement }) =>
      onDraft({ typed: event.currentTarget.value }),
    [onDraft]
  );
  return (
    <div className="ty-generate-fields">
      <Select
        label={isEditable(face) ? "Editable face" : "Variable face"}
        onChange={chooseFace}
        options={faces}
        value={face.id}
      />
      <Segmented
        disabled={replaying}
        label="Characters to generate"
        onChange={chooseSource}
        options={SOURCES}
        value={draft.source}
      />
      {draft.source === "typed" ? (
        <TextField
          disabled={replaying}
          hint="Type the characters, or write them as U+00E9. A character the face already has is generated as a holdout test."
          label="Characters"
          onChange={type}
          placeholder="é è ñ"
          value={draft.typed}
        />
      ) : null}
      {draft.source === "script" ? (
        <Select
          disabled={replaying}
          label="Missing in the writing system"
          onChange={chooseScope}
          options={SCOPE_OPTIONS}
          value={draft.scope}
        />
      ) : null}
      {draft.source === "language" ? (
        <Select
          disabled={replaying || !languages}
          label="Missing for the language"
          onChange={chooseLanguage}
          options={languageOptions}
          value={draft.language}
        />
      ) : null}
    </div>
  );
}
