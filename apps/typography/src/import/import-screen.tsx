import "./import.css";
import { useCallback, useState } from "react";
import { useApplication } from "~/application/react";
import { useProject } from "~/library/use-face";
import { ButtonLink } from "~/ui/controls/button";
import { FileDrop } from "~/ui/controls/file-drop";
import type { SortedFiles } from "~/ui/controls/file-sorting";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { Columns } from "~/ui/layout/columns";
import { RuledSection } from "~/ui/layout/ruled-section";
import { readFiles } from "~/workspace/files";
import type { ImportFile } from "~/workspace/importing";
import { summariseImport } from "./imported-sources";
import { SampleFonts } from "./sample-fonts";
import { SourcesTable } from "./sources-table";
import { StartSection } from "./start-section";

const FONT_FILES = [".ttf", ".otf"] as const;

/** Import: bring font files into the project, or load the samples, and see what is in it. */
export default function ImportScreen() {
  const application = useApplication();
  const project = useProject();
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<string>();
  const [unreadable, setUnreadable] = useState(false);

  const importFiles = useCallback(
    async (files: readonly ImportFile[]) => {
      setImporting(true);
      setSummary(undefined);
      try {
        setSummary(summariseImport(await application.import(files)));
      } finally {
        setImporting(false);
      }
    },
    [application]
  );

  const takeFiles = useCallback(
    async ({ accepted }: SortedFiles) => {
      if (accepted.length === 0) {
        return;
      }
      setUnreadable(false);
      let files: ImportFile[];
      try {
        files = await readFiles(accepted);
      } catch {
        setUnreadable(true);
        return;
      }
      await importFiles(files);
    },
    [importFiles]
  );

  const dismissSummary = useCallback(() => setSummary(undefined), []);
  const dismissUnreadable = useCallback(() => setUnreadable(false), []);

  const empty = project.sources.length === 0;

  return (
    <>
      {empty ? <StartSection /> : null}
      <RuledSection
        first={!empty}
        heading="Import"
        lede="Add TrueType and OpenType font files. Each file is kept exactly as it is, and nothing leaves this machine."
      >
        <Columns>
          <div className="ty-import-column">
            <FileDrop
              accept={FONT_FILES}
              disabled={importing}
              label="Add font files"
              onFiles={takeFiles}
            />
            {importing ? <ProgressLine label="Reading the fonts" /> : null}
            {unreadable ? (
              <Notice onDismiss={dismissUnreadable} tone="problem">
                The browser could not read the chosen files. Check that they
                still exist, then choose them again.
              </Notice>
            ) : null}
            {summary ? (
              <Notice onDismiss={dismissSummary}>{summary}</Notice>
            ) : null}
          </div>
          <div className="ty-import-column">
            <h3 className="ty-label">Sample fonts</h3>
            <p>
              No font to hand? These openly licensed fonts come with the app.
            </p>
            <SampleFonts
              busy={importing}
              onImport={importFiles}
              project={project}
            />
          </div>
        </Columns>
      </RuledSection>
      <RuledSection
        heading="In the project"
        lede="The source fonts imported so far. Removing one takes its faces out of the project."
      >
        {empty ? (
          <p>
            Nothing is imported yet. Drop font files above, or load the sample
            fonts.
          </p>
        ) : (
          <div className="ty-import-column">
            <SourcesTable project={project} />
            <div className="ty-import-actions">
              <ButtonLink href="#/library">Open the library</ButtonLink>
              <ButtonLink href="#/coverage">Open coverage</ButtonLink>
            </div>
          </div>
        )}
      </RuledSection>
    </>
  );
}
