import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { SearchField } from "~/ui/controls/search-field";
import { Segmented } from "~/ui/controls/segmented";
import { TextField } from "~/ui/controls/text-field";
import { RuledSection } from "~/ui/layout/ruled-section";
import type { SharedGroupId } from "~/unicode/scripts";
import { OptionChecks } from "./option-checks";
import type { PlanDraft } from "./plan-draft";
import {
  matchingOptions,
  type SelectionOption,
  type SelectionOptions,
} from "./selection-options";
import type { SelectionSummary } from "./selection-summary";
import { readRanges } from "./typed-ranges";
import type { LanguageData } from "./use-export";

export interface FaceSelection {
  readonly faceId: string;
  readonly label: string;
  readonly summary: SelectionSummary;
}

interface CharactersSectionProps {
  readonly draft: PlanDraft;
  readonly languageData: LanguageData;
  /** The languages the chosen faces can set. */
  readonly languages: readonly SelectionOption[];
  readonly onChange: (change: Partial<PlanDraft>) => void;
  readonly options: SelectionOptions;
  /** One per chosen face. */
  readonly selections: readonly FaceSelection[];
}

const KEEP_OPTIONS = [
  { label: "Everything", value: "everything" },
  { label: "A selection", value: "selection" },
] as const;

const LISTED_LANGUAGES = 40;
const LISTED_GROUPS = 6;

const number = (value: number) => value.toLocaleString("en");

const describeLeftOut = ({ leftOut, leftOutCount }: SelectionSummary) => {
  if (leftOutCount === 0) {
    return "Nothing";
  }
  const listed = leftOut
    .slice(0, LISTED_GROUPS)
    .map((group) => `${group.name} ${number(group.count)}`)
    .join(", ");
  const more = leftOut.length > LISTED_GROUPS ? ", and others" : "";
  return `${number(leftOutCount)} characters: ${listed}${more}`;
};

const COLUMNS: readonly DataColumn<FaceSelection>[] = [
  { cell: (row) => row.label, header: "Face", id: "face", kind: "label" },
  {
    cell: ({ summary }) =>
      `${number(summary.kept)} of ${number(summary.available)}`,
    header: "Characters kept",
    id: "kept",
    kind: "numeric",
  },
  {
    cell: ({ summary }) =>
      summary.glyphsExact
        ? number(summary.glyphFloor)
        : `${number(summary.glyphFloor)} or more`,
    header: "Glyphs, estimated",
    id: "glyphs",
    kind: "numeric",
  },
  {
    cell: ({ summary }) => describeLeftOut(summary),
    header: "Left out",
    id: "left-out",
    kind: "text",
  },
];

const selectionKey = (row: FaceSelection) => row.faceId;

interface LanguageChoicesProps {
  readonly data: LanguageData;
  readonly onChange: (languages: string[]) => void;
  readonly options: readonly SelectionOption[];
  readonly selected: readonly string[];
}

/** Languages are many, so they are found by name and only a first page is listed. */
function LanguageChoices({
  data,
  onChange,
  options,
  selected,
}: LanguageChoicesProps) {
  const [query, setQuery] = useState("");
  const matching = useMemo(
    () => matchingOptions(options, query),
    [options, query]
  );
  // What is already chosen stays in sight whatever the query says.
  const chosen = options.filter((option) => selected.includes(option.value));
  const listed = [
    ...chosen,
    ...matching.filter((option) => !selected.includes(option.value)),
  ].slice(0, Math.max(LISTED_LANGUAGES, chosen.length));
  const hidden = matching.length - listed.length;
  return (
    <OptionChecks
      empty={
        data.status === "unavailable"
          ? "The language data did not load. Reload the page to choose by language."
          : "No language matches. A language is listed when the chosen faces hold every character its everyday text needs."
      }
      legend="Languages"
      onChange={onChange}
      options={listed}
      selected={selected}
    >
      <p className="ty-export-hint">
        A language keeps the characters its everyday text needs, capitals
        included. Characters for loanwords and names are not part of it.
      </p>
      <SearchField
        label="Find a language"
        onChange={setQuery}
        placeholder="Hindi, Polish, vi"
        value={query}
      />
      {hidden > 0 ? (
        <p className="ty-export-hint">
          {number(hidden)} more match. Type more of the name to find them.
        </p>
      ) : null}
    </OptionChecks>
  );
}

/** What the plan keeps: everything, or any combination of ways to name characters. */
export function CharactersSection({
  draft,
  languageData,
  languages,
  onChange,
  options,
  selections,
}: CharactersSectionProps) {
  const setKeep = useCallback(
    (keep: PlanDraft["keep"]) => onChange({ keep }),
    [onChange]
  );
  const setScripts = useCallback(
    (scripts: string[]) => onChange({ scripts }),
    [onChange]
  );
  const setGroups = useCallback(
    (sharedGroups: SharedGroupId[]) => onChange({ sharedGroups }),
    [onChange]
  );
  const setBlocks = useCallback(
    (blocks: string[]) => onChange({ blocks }),
    [onChange]
  );
  const setLanguages = useCallback(
    (chosen: string[]) => onChange({ languages: chosen }),
    [onChange]
  );
  const setTyped = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ typed: event.currentTarget.value }),
    [onChange]
  );
  const setRanges = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ ranges: event.currentTarget.value }),
    [onChange]
  );
  const { unreadable } = readRanges(draft.ranges);

  return (
    <RuledSection
      heading="Characters"
      lede="Keep every character, or only the ones a selection names. Choices add up: the plan keeps a character when any of them names it and the face has it."
    >
      <div className="ty-export-stack">
        <Segmented
          label="What to keep"
          onChange={setKeep}
          options={KEEP_OPTIONS}
          value={draft.keep}
        />
        {draft.keep === "selection" ? (
          <div className="ty-export-choices">
            <OptionChecks
              empty="Choose a face first. Its writing systems are listed here."
              legend="Writing systems"
              onChange={setScripts}
              options={options.scripts}
              selected={draft.scripts}
            />
            <OptionChecks
              empty="The chosen faces hold no shared characters."
              legend="Shared by all writing systems"
              onChange={setGroups}
              options={options.sharedGroups}
              selected={draft.sharedGroups}
            >
              <p className="ty-export-hint">
                Spaces, digits and punctuation belong to no single writing
                system, so a writing system alone leaves them out.
              </p>
            </OptionChecks>
            <OptionChecks
              empty="Choose a face first. Its Unicode blocks are listed here."
              legend="Unicode blocks"
              onChange={setBlocks}
              options={options.blocks}
              selected={draft.blocks}
            />
            <LanguageChoices
              data={languageData}
              onChange={setLanguages}
              options={languages}
              selected={draft.languages}
            />
            <fieldset className="ty-export-options">
              <legend className="ty-label">Typed</legend>
              <TextField
                hint="Every character typed here is kept, spaces included."
                label="Characters"
                onChange={setTyped}
                value={draft.typed}
              />
              <TextField
                error={
                  unreadable.length > 0
                    ? `${unreadable.map((piece) => `"${piece}"`).join(", ")} could not be read. Write code points as U+0041 and ranges as U+0041-U+005A.`
                    : undefined
                }
                hint="Code points and ranges with commas between them, such as U+20AC, U+0100-U+017F."
                label="Code points and ranges"
                onChange={setRanges}
                value={draft.ranges}
              />
            </fieldset>
          </div>
        ) : null}
        {selections.length > 0 ? (
          <div>
            <DataTable
              caption="What the selection keeps and leaves out, face by face"
              columns={COLUMNS}
              rowKey={selectionKey}
              rows={selections}
            />
            <p className="ty-export-hint">
              The glyph count is a floor until the font is built: the glyphs the
              kept characters map to, and the fallback glyph. Ligatures and
              alternates that kept features reach are added by the build.
            </p>
          </div>
        ) : null}
      </div>
    </RuledSection>
  );
}
