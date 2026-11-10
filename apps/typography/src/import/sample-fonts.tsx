import "./import.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TypefaceProject } from "~/typeface/project";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { Button } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import type { ImportFile } from "~/workspace/importing";
import {
  type Fetch,
  fetchSamples,
  listSamples,
  type SampleFont,
} from "./samples";

const browserFetch: Fetch = (address) => fetch(address);
const BASE = import.meta.env.BASE_URL;

interface LoadButtonProps {
  readonly disabled: boolean;
  readonly onLoad: (sample: SampleFont) => void;
  readonly sample: SampleFont;
}

function LoadButton({ disabled, onLoad, sample }: LoadButtonProps) {
  const load = useCallback(() => onLoad(sample), [onLoad, sample]);
  return (
    <Button disabled={disabled} onClick={load} symbol="add">
      Load<span className="ty-visually-hidden"> {sample.file}</span>
    </Button>
  );
}

const columnsFor = (
  onLoad: (sample: SampleFont) => void,
  loadable: (sample: SampleFont) => boolean
): readonly DataColumn<SampleFont>[] => [
  { cell: (sample) => sample.file, header: "File", id: "file", kind: "text" },
  {
    cell: (sample) => (
      <>
        {sample.copyright}{" "}
        <a href={sample.licenceAddress} rel="noreferrer" target="_blank">
          Read the licence
          <span className="ty-visually-hidden"> of {sample.file}</span>
        </a>
      </>
    ),
    header: "Licence",
    id: "licence",
    kind: "text",
  },
  {
    cell: (sample) => (
      <LoadButton
        disabled={!loadable(sample)}
        onLoad={onLoad}
        sample={sample}
      />
    ),
    header: "Load",
    id: "load",
    kind: "numeric",
  },
];

const sampleKey = (sample: SampleFont) => sample.file;

type Listing =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "listed"; readonly samples: readonly SampleFont[] };

interface SampleFontsProps {
  readonly busy: boolean;
  /** Imports the fetched files. Resolves when the import has finished. */
  readonly onImport: (files: readonly ImportFile[]) => Promise<void>;
  readonly project: TypefaceProject;
}

/**
 * Openly licensed fonts served with the app, for someone with no font to
 * hand. Each is listed with the copyright line of its licence and can be
 * loaded on its own, and one action loads them all.
 */
export function SampleFonts({ busy, onImport, project }: SampleFontsProps) {
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [fetching, setFetching] = useState(false);
  const [failed, setFailed] = useState(false);

  const list = useCallback(() => {
    setListing({ state: "loading" });
    listSamples(browserFetch, BASE).then(
      (listed) => setListing({ samples: listed, state: "listed" }),
      () => setListing({ state: "failed" })
    );
  }, []);
  useEffect(list, [list]);

  const samples = listing.state === "listed" ? listing.samples : [];
  const present = useMemo(
    () => new Set(project.sources.map((source) => source.fileName)),
    [project.sources]
  );
  const wanted = samples.filter((sample) => !present.has(sample.file));

  const fetchAndImport = useCallback(
    async (chosen: readonly SampleFont[]) => {
      setFetching(true);
      setFailed(false);
      try {
        await onImport(await fetchSamples(browserFetch, BASE, chosen));
      } catch {
        setFailed(true);
      } finally {
        setFetching(false);
      }
    },
    [onImport]
  );
  const loadAll = useCallback(
    () => fetchAndImport(wanted),
    [fetchAndImport, wanted]
  );
  const loadOne = useCallback(
    (sample: SampleFont) => {
      fetchAndImport([sample]);
    },
    [fetchAndImport]
  );
  const idle = !(busy || fetching);
  const columns = useMemo(
    () => columnsFor(loadOne, (sample) => idle && !present.has(sample.file)),
    [idle, loadOne, present]
  );

  if (listing.state === "loading") {
    return <ProgressLine label="Listing the sample fonts" />;
  }
  if (listing.state === "failed") {
    return (
      <Notice
        action={<Button onClick={list}>List the samples again</Button>}
        tone="problem"
      >
        The sample fonts could not be listed. Check that the app is still being
        served, then list them again.
      </Notice>
    );
  }
  return (
    <div className="ty-import-samples">
      <DataTable
        caption="Sample fonts and their licences"
        columns={columns}
        rowKey={sampleKey}
        rows={samples}
      />
      {failed ? (
        <Notice tone="problem">
          The sample fonts could not be fetched. Check that the app is still
          being served, then load them again.
        </Notice>
      ) : null}
      {fetching ? <ProgressLine label="Fetching the sample fonts" /> : null}
      <div className="ty-import-actions">
        <Button
          disabled={!idle || wanted.length === 0}
          onClick={loadAll}
          symbol="add"
          variant="solid"
        >
          Load sample fonts
        </Button>
        {wanted.length === 0 ? (
          <span>Every sample is in the project.</span>
        ) : null}
      </div>
    </div>
  );
}
