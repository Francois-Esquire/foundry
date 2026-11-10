import { useCallback, useEffect, useState } from "react";
import { TitleBlock, TitleBlockItem } from "~/ui/content/title-block";
import { Button } from "~/ui/controls/button";
import { FileDrop } from "~/ui/controls/file-drop";
import type { SortedFiles } from "~/ui/controls/file-sorting";
import { Notice } from "~/ui/controls/notice";
import { ProgressLine } from "~/ui/controls/progress-line";
import { Columns } from "~/ui/layout/columns";
import { readFiles, saveBytes } from "~/workspace/files";
import type { Evidence } from "./core";
import {
  type Fetch,
  fetchSamplePhotograph,
  listSamplePhotographs,
  type SamplePhotograph,
} from "./samples";
import type { ReconstructSession, ReconstructState } from "./session";

const PICTURE_FILES = [".jpg", ".jpeg", ".png", ".webp"] as const;
const browserFetch: Fetch = (address) => fetch(address);
const BASE = import.meta.env.BASE_URL;

type Listing =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | {
      readonly state: "listed";
      readonly samples: readonly SamplePhotograph[];
    };

interface SampleRowProps {
  readonly disabled: boolean;
  readonly onOpen: (sample: SamplePhotograph) => void;
  readonly sample: SamplePhotograph;
}

function SampleRow({ disabled, onOpen, sample }: SampleRowProps) {
  const open = useCallback(() => onOpen(sample), [onOpen, sample]);
  return (
    <li>
      <div>
        <h4 className="ty-label">{sample.title}</h4>
        <p>{sample.description}</p>
        <p className="ty-reconstruct-small">
          {sample.licence}.{" "}
          <a href={sample.source} rel="noreferrer" target="_blank">
            See where it was published
            <span className="ty-visually-hidden">: {sample.title}</span>
          </a>
        </p>
      </div>
      <Button disabled={disabled} onClick={open}>
        Open {sample.title.toLowerCase()}
      </Button>
    </li>
  );
}

interface SamplePhotographsProps {
  readonly disabled: boolean;
  readonly session: ReconstructSession;
}

/** Photographs of lettering served with the app, for someone with none to hand. */
function SamplePhotographs({ disabled, session }: SamplePhotographsProps) {
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [failed, setFailed] = useState<string>();

  const list = useCallback(() => {
    setListing({ state: "loading" });
    listSamplePhotographs(browserFetch, BASE).then(
      (samples) => setListing({ samples, state: "listed" }),
      () => setListing({ state: "failed" })
    );
  }, []);
  useEffect(list, [list]);

  const open = useCallback(
    async (sample: SamplePhotograph) => {
      setFailed(undefined);
      try {
        await session.openEvidence(
          await fetchSamplePhotograph(browserFetch, BASE, sample)
        );
      } catch {
        setFailed(sample.title);
      }
    },
    [session]
  );

  if (listing.state === "loading") {
    return <ProgressLine label="Listing the sample photographs" />;
  }
  if (listing.state === "failed") {
    return (
      <Notice
        action={<Button onClick={list}>List the samples again</Button>}
        tone="problem"
      >
        The sample photographs could not be listed. Check that the app is still
        being served, then list them again.
      </Notice>
    );
  }
  return (
    <>
      <ul className="ty-reconstruct-samples">
        {listing.samples.map((sample) => (
          <SampleRow
            disabled={disabled}
            key={sample.file}
            onOpen={open}
            sample={sample}
          />
        ))}
      </ul>
      {failed ? (
        <Notice tone="problem">
          {failed} could not be fetched. Check that the app is still being
          served, then open it again.
        </Notice>
      ) : null}
    </>
  );
}

const DIGEST_SHOWN = 16;

interface OpenEvidenceProps {
  readonly evidence: Evidence;
  readonly session: ReconstructSession;
}

/** The facts of the open evidence, and the way to get the file back exactly as it came. */
function OpenEvidence({ evidence, session }: OpenEvidenceProps) {
  const exportOriginal = useCallback(
    () => saveBytes(evidence.fileName, evidence.file.bytes),
    [evidence]
  );
  const close = useCallback(() => session.closeEvidence(), [session]);
  return (
    <div className="ty-reconstruct-stack">
      <TitleBlock>
        <TitleBlockItem label="Evidence" weight={2}>
          {evidence.fileName}
        </TitleBlockItem>
        <TitleBlockItem label="Size">
          {evidence.width} by {evidence.height} pixels
        </TitleBlockItem>
        <TitleBlockItem label="File">
          {evidence.file.bytes.byteLength.toLocaleString("en")} bytes
        </TitleBlockItem>
        <TitleBlockItem label="SHA-256" weight={2}>
          <span className="ty-code" title={evidence.id}>
            {evidence.id.slice(0, DIGEST_SHOWN)}
          </span>
        </TitleBlockItem>
      </TitleBlock>
      <div className="ty-reconstruct-actions">
        <Button onClick={exportOriginal} symbol="download">
          Export the original photograph
        </Button>
        <Button onClick={close} symbol="close">
          Close the photograph
        </Button>
        <p className="ty-reconstruct-small">
          The file is kept byte for byte. Everything below is drawn over it or
          read from it, and nothing is written to it.
        </p>
      </div>
    </div>
  );
}

interface EvidenceSectionProps {
  readonly session: ReconstructSession;
  readonly state: ReconstructState;
}

/** Bringing evidence in: a dropped or chosen picture, or a sample photograph. */
export function EvidenceSection({ session, state }: EvidenceSectionProps) {
  const [unreadable, setUnreadable] = useState(false);
  const busy = state.opening !== undefined;

  const takeFiles = useCallback(
    async ({ accepted }: SortedFiles) => {
      if (accepted.length === 0) {
        return;
      }
      setUnreadable(false);
      try {
        const [file] = await readFiles(accepted);
        if (file) {
          await session.openEvidence({
            bytes: file.bytes,
            fileName: file.name,
          });
        }
      } catch {
        setUnreadable(true);
      }
    },
    [session]
  );

  if (state.evidence) {
    return <OpenEvidence evidence={state.evidence} session={session} />;
  }
  return (
    <Columns>
      <div className="ty-reconstruct-stack">
        <FileDrop
          accept={PICTURE_FILES}
          disabled={busy}
          label="Add a photograph of lettering"
          multiple={false}
          onFiles={takeFiles}
        />
        {state.opening ? (
          <ProgressLine label={`Reading ${state.opening}`} />
        ) : null}
        {unreadable ? (
          <Notice tone="problem">
            The browser could not read the chosen file. Check that it still
            exists, then choose it again.
          </Notice>
        ) : null}
        {state.evidenceProblem ? (
          <Notice tone="problem">{state.evidenceProblem}</Notice>
        ) : null}
      </div>
      <div className="ty-reconstruct-stack">
        <h3 className="ty-label">Sample photographs</h3>
        <p>
          No photograph to hand? These real photographs of lettering come with
          the app. None is modified.
        </p>
        <SamplePhotographs disabled={busy} session={session} />
      </div>
    </Columns>
  );
}
