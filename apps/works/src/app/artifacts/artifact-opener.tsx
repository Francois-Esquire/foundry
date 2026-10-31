import { useCallback, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import { Dialog } from "~/app/components/dialog";
import type {
  ArtifactEntryOption,
  ArtifactResolution,
  EditorCandidate,
} from "~/shared/artifacts";
import { editorPath } from "./open-editor";

type Resolved = Exclude<ArtifactResolution, { kind: "module" }>;
type EditorsResolution = Extract<ArtifactResolution, { kind: "editors" }>;

type OpenerState =
  | { step: "idle" }
  | { step: "working" }
  | { message: string; step: "failed" }
  | { choose: boolean; resolution: Resolved; step: "asking" };

export interface ArtifactOpener {
  close: () => void;
  /** Opens at the declared entry and remembered editor, asking only when needed. */
  open: (id: string) => void;
  /** Always asks which editor, even with one match or a remembered choice. */
  openWith: (id: string) => void;
  pickEditor: (editor: EditorCandidate) => void;
  pickEntry: (entry: ArtifactEntryOption) => void;
  readonly state: OpenerState;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The editor to open without asking: the only match or the remembered one. */
function directEditor(
  resolution: ArtifactResolution,
  choose: boolean
): EditorCandidate | null {
  if (choose || resolution.kind !== "editors") {
    return null;
  }
  const [only] = resolution.candidates;
  return resolution.candidates.length === 1 && only
    ? only
    : resolution.preferred;
}

/**
 * The open flow: resolve the Artifact, ask for an entry when it has no
 * primary one, ask for an editor when several match (main remembers the
 * choice), then hand the open request to the editor route.
 */
export function useArtifactOpener(): ArtifactOpener {
  const navigate = useNavigate();
  const [state, setState] = useState<OpenerState>({ step: "idle" });
  // Each step supersedes the last; a late answer to an older one is dropped.
  const attempt = useRef(0);

  const step = useCallback(async (work: (current: number) => Promise<void>) => {
    attempt.current += 1;
    const { current } = attempt;
    setState({ step: "working" });
    try {
      await work(current);
    } catch (error) {
      if (attempt.current === current) {
        setState({ message: messageOf(error), step: "failed" });
      }
    }
  }, []);

  const openIn = useCallback(
    async (
      current: number,
      resolution: EditorsResolution,
      editor: EditorCandidate
    ) => {
      const request = await worksApi().artifacts.open.call({
        contentId: resolution.contentId,
        entry: resolution.entry.path,
        id: resolution.artifact.id,
        moduleId: editor.moduleId,
        view: editor.view,
      });
      if (attempt.current === current) {
        setState({ step: "idle" });
        navigate(editorPath(request));
      }
    },
    [navigate]
  );

  const resolve = useCallback(
    (input: { entry?: string; id: string }, choose: boolean) =>
      step(async (current) => {
        const resolution = await worksApi().artifacts.resolve.call(input);
        if (attempt.current !== current) {
          return;
        }
        if (resolution.kind === "module") {
          setState({ step: "idle" });
          navigate(`/modules/${encodeURIComponent(resolution.moduleId)}`);
          return;
        }
        const direct = directEditor(resolution, choose);
        if (direct && resolution.kind === "editors") {
          await openIn(current, resolution, direct);
          return;
        }
        setState({ choose, resolution, step: "asking" });
      }),
    [navigate, openIn, step]
  );

  const pickEditor = useCallback(
    (editor: EditorCandidate) => {
      if (state.step === "asking" && state.resolution.kind === "editors") {
        const { resolution } = state;
        step((current) => openIn(current, resolution, editor));
      }
    },
    [openIn, state, step]
  );

  const pickEntry = useCallback(
    (entry: ArtifactEntryOption) => {
      if (state.step === "asking") {
        resolve(
          { entry: entry.path, id: state.resolution.artifact.id },
          state.choose
        );
      }
    },
    [resolve, state]
  );

  return {
    close: useCallback(() => {
      attempt.current += 1;
      setState({ step: "idle" });
    }, []),
    open: useCallback((id: string) => resolve({ id }, false), [resolve]),
    openWith: useCallback((id: string) => resolve({ id }, true), [resolve]),
    pickEditor,
    pickEntry,
    state,
  };
}

function EntryItem({
  entry,
  onPick,
}: {
  entry: ArtifactEntryOption;
  onPick: (entry: ArtifactEntryOption) => void;
}) {
  const pick = useCallback(() => onPick(entry), [entry, onPick]);
  return (
    <li>
      <Button
        className="h-auto w-full justify-between gap-3 rounded-xl py-2 text-left"
        onClick={pick}
        variant="ghost"
      >
        <span className="min-w-0 truncate font-mono text-xs">{entry.path}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {entry.mime ?? "Unknown type"}
        </span>
      </Button>
    </li>
  );
}

function EditorItem({
  editor,
  onPick,
  preferred,
}: {
  editor: EditorCandidate;
  onPick: (editor: EditorCandidate) => void;
  preferred: boolean;
}) {
  const pick = useCallback(() => onPick(editor), [editor, onPick]);
  return (
    <li>
      <Button
        className="h-auto w-full justify-between gap-3 rounded-xl py-2 text-left"
        onClick={pick}
        variant="ghost"
      >
        <span className="min-w-0 truncate">
          {editor.viewTitle ?? editor.view} — {editor.moduleName}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {editor.mode === "write" ? "Can edit" : "Read only"}
          {preferred ? " · Your choice" : ""}
        </span>
      </Button>
    </li>
  );
}

function editorsDescription(resolution: EditorsResolution): string {
  const { candidates, entry, match, mime } = resolution;
  if (match === "family") {
    return `No editor declares ${mime} itself; these open files of the same kind. Choose one for ${entry.path}. Works remembers your choice.`;
  }
  return candidates.length > 1
    ? `Several editors open ${mime} files. Choose one for ${entry.path}. Works remembers your choice.`
    : `This editor opens ${entry.path} (${mime}).`;
}

function EditorsDialog({
  onClose,
  onPick,
  resolution,
}: {
  onClose: () => void;
  onPick: (editor: EditorCandidate) => void;
  resolution: EditorsResolution;
}) {
  const { candidates, entry, mime, preferred } = resolution;
  if (candidates.length === 0) {
    return (
      <Dialog
        description={`No installed module opens ${entry.path} (${mime}). Load an editor module that opens it, then try again.`}
        onClose={onClose}
        title="No editor available"
      >
        <Button asChild className="mt-4" variant="outline">
          <Link onClick={onClose} to="/modules">
            Browse the Modules Catalog
          </Link>
        </Button>
      </Dialog>
    );
  }
  return (
    <Dialog
      description={editorsDescription(resolution)}
      onClose={onClose}
      title={`Open ${resolution.artifact.name} with`}
    >
      <ul aria-label="Editors" className="mt-4 grid gap-1">
        {candidates.map((editor) => (
          <EditorItem
            editor={editor}
            key={`${editor.moduleId}:${editor.view}`}
            onPick={onPick}
            preferred={
              editor.moduleId === preferred?.moduleId &&
              editor.view === preferred.view
            }
          />
        ))}
      </ul>
    </Dialog>
  );
}

/** The opener's questions and refusals as a dialog; nothing otherwise. */
export function ArtifactOpenerDialog({ opener }: { opener: ArtifactOpener }) {
  const { close, pickEditor, pickEntry, state } = opener;
  if (state.step === "failed") {
    return (
      <Dialog
        description={state.message}
        onClose={close}
        title="This artifact could not be opened"
      />
    );
  }
  if (state.step !== "asking") {
    return null;
  }
  const { resolution } = state;
  if (resolution.kind === "empty") {
    return (
      <Dialog
        description="This artifact has no files yet, so there is nothing to open."
        onClose={close}
        title={resolution.artifact.name}
      />
    );
  }
  if (resolution.kind === "entries") {
    return (
      <Dialog
        description={`${resolution.artifact.name} has ${resolution.entries.length} files and no main file. Choose the one to open.`}
        onClose={close}
        title="Choose a file to open"
      >
        <ul aria-label="Files" className="mt-4 grid gap-1">
          {resolution.entries.map((entry) => (
            <EntryItem entry={entry} key={entry.path} onPick={pickEntry} />
          ))}
        </ul>
      </Dialog>
    );
  }
  return (
    <EditorsDialog
      onClose={close}
      onPick={pickEditor}
      resolution={resolution}
    />
  );
}
