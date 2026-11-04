import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { worksApi } from "~/app/api/client";
import type { AuthoringProposalFiles, ProposalFiles } from "~/shared/authoring";
import type {
  ModuleBuildEvent,
  ModuleDetails,
  ModuleRelease,
  ModuleSourceRevision,
} from "~/shared/modules";
import {
  clearModuleDraft,
  readModuleDraft,
  sameSource,
  writeModuleDraft,
} from "./module-draft";
import {
  applyFiles,
  holdAll,
  type ProposalConflict,
  reconcileProposal,
  withConflicts,
} from "./proposal";

function nextVersion(releases: ModuleRelease[]) {
  let patch = 0;
  while (releases.some((release) => release.tag === `0.1.${patch}`)) {
    patch += 1;
  }
  return `0.1.${patch}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Build failed";
}

/**
 * The Draft: the working source, the saved source and binding it is
 * edited against, and the proposal files waiting for a choice. One record,
 * written in one place, so every reader sees the same Draft.
 */
interface Draft {
  /** Saved source at `expected`; what "unsaved changes" compare against. */
  readonly baseline: Readonly<Record<string, string>>;
  readonly conflicts: readonly ProposalConflict[];
  readonly expected: ModuleSourceRevision | null;
  readonly source: Readonly<Record<string, string>>;
}

/** What the chat changes in the Draft. Every call acts on the Draft as it is now. */
export interface DraftProposals {
  /**
   * Reconcile an accepted proposal against the Draft now and apply it in
   * the same step; conflicting files wait for a choice.
   */
  accept(
    turnId: string,
    files: AuthoringProposalFiles
  ): { applied: number; conflicts: number };
  current(): Pick<Draft, "expected" | "source">;
  /** Forget a dismissed proposal's conflicts. */
  drop(turnId: string): void;
  /** Hold every file the proposal would change; returns how many. */
  holdAll(turnId: string, files: AuthoringProposalFiles): number;
  /** Settle one conflict with a whole version; returns how many of its proposal remain. */
  resolve(conflict: ProposalConflict, choice: "draft" | "proposal"): number;
}

function initialDraft(details: ModuleDetails) {
  try {
    const draft = readModuleDraft(details.id);
    return {
      expected: draft?.expected ?? details.binding,
      notice: draft
        ? "Recovered your local draft. Save it before building."
        : "",
      source: draft?.source ?? details.source,
    };
  } catch {
    return {
      expected: details.binding,
      notice: "The local draft could not be loaded. Saved source is available.",
      source: details.source,
    };
  }
}

export function useModuleEditor(
  details: ModuleDetails,
  refresh: () => Promise<ModuleDetails>,
  /** Told in the same update that holds new conflicts. */
  onConflicts: () => void
) {
  const [initial] = useState(() => initialDraft(details));
  const draft = useRef<Draft>({
    baseline: details.source,
    conflicts: [],
    expected: initial.expected,
    source: initial.source,
  });
  const [shown, setShown] = useState(draft.current);
  const { baseline, conflicts, expected, source } = shown;
  const [notice, setNotice] = useState(initial.notice);
  const [selected, setSelected] = useState(
    Object.hasOwn(source, "packages/app/src/App.tsx")
      ? "packages/app/src/App.tsx"
      : Object.keys(source).sort()[0]
  );
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [event, setEvent] = useState<ModuleBuildEvent>();
  const [logs, setLogs] = useState("");
  const [tag, setTag] = useState(() => nextVersion(details.releases));
  const [editorRevision, setEditorRevision] = useState(0);
  const [builtId, setBuiltId] = useState<string>();
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => () => lifetime.current?.abort(), []);
  const dirty = !sameSource(source, baseline);
  const path =
    selected && Object.hasOwn(source, selected)
      ? selected
      : Object.keys(source).sort()[0];
  const pathRef = useRef(path);
  pathRef.current = path;
  const onConflictsRef = useRef(onConflicts);
  onConflictsRef.current = onConflicts;
  useEffect(() => {
    if (!dirty) {
      return;
    }
    // Electron asks main to confirm before a window with unsaved edits closes.
    const warn = (unload: BeforeUnloadEvent) => unload.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  /**
   * The one writer of the Draft. Unsaved changes are kept locally with the
   * binding they are edited against, so a reload recovers exactly this Draft.
   */
  const update = useCallback(
    (change: Partial<Draft>) => {
      const next = { ...draft.current, ...change };
      draft.current = next;
      setShown(next);
      try {
        if (next.expected && !sameSource(next.source, next.baseline)) {
          writeModuleDraft(details.id, next.source, next.expected);
        } else {
          clearModuleDraft(details.id);
        }
      } catch {
        setNotice(
          "Your draft could not be stored locally. Save before leaving this module."
        );
      }
    },
    [details.id]
  );
  /** Replace the working source; refused while there is no editable source. */
  const keepSource = useCallback(
    (next: Record<string, string>) => {
      if (draft.current.expected) {
        update({ source: next });
      }
    },
    [update]
  );
  /** Write proposal files into the source; the open file reloads if it changed. */
  const write = useCallback(
    (changes: ProposalFiles) => {
      if (Object.keys(changes).length === 0) {
        return;
      }
      keepSource(applyFiles(draft.current.source, changes));
      if (Object.hasOwn(changes, pathRef.current ?? "")) {
        setEditorRevision((revision) => revision + 1);
      }
    },
    [keepSource]
  );
  const hold = useCallback(
    (held: readonly ProposalConflict[]) => {
      if (held.length === 0) {
        return;
      }
      update({ conflicts: withConflicts(draft.current.conflicts, held) });
      onConflictsRef.current();
    },
    [update]
  );
  // The editor reports its own text, so the open file is not reloaded.
  const edit = useCallback(
    (file: string, contents: string) =>
      keepSource({ ...draft.current.source, [file]: contents }),
    [keepSource]
  );
  const proposals = useMemo<DraftProposals>(
    () => ({
      accept(turnId, files) {
        if (!draft.current.expected) {
          throw new Error("This module has no editable source");
        }
        // Reconciled and applied in one synchronous step against the Draft
        // as it is now, so no edit can land between the two.
        const { changes, conflicts: held } = reconcileProposal(
          turnId,
          draft.current.source,
          files.base,
          files.proposal
        );
        write(changes);
        hold(held);
        return { applied: Object.keys(changes).length, conflicts: held.length };
      },
      current: () => draft.current,
      drop(turnId) {
        update({
          conflicts: draft.current.conflicts.filter(
            (conflict) => conflict.turnId !== turnId
          ),
        });
      },
      holdAll(turnId, files) {
        const held = holdAll(turnId, draft.current.source, files);
        hold(held);
        return held.length;
      },
      resolve(conflict, choice) {
        if (choice === "proposal") {
          write({ [conflict.path]: conflict.proposal });
        }
        const remaining = draft.current.conflicts.filter(
          (entry) =>
            !(entry.turnId === conflict.turnId && entry.path === conflict.path)
        );
        update({ conflicts: remaining });
        return remaining.filter((entry) => entry.turnId === conflict.turnId)
          .length;
      },
    }),
    [hold, update, write]
  );
  const selectFile = useCallback((file: string) => setSelected(file), []);
  const save = useCallback(
    async (signal?: AbortSignal): Promise<ModuleSourceRevision> => {
      const {
        baseline: saved,
        expected: binding,
        source: saving,
      } = draft.current;
      if (!binding) {
        throw new Error("This module has no editable source");
      }
      if (sameSource(saving, saved)) {
        return binding;
      }
      const next = await worksApi().modules.saveSource.call(
        { expected: binding, id: details.id, source: saving },
        { signal }
      );
      // Edits made while saving stay unsaved, now against the new binding.
      update({ baseline: saving, expected: next });
      return next;
    },
    [details.id, update]
  );
  const saveSource = useCallback(async () => {
    setBusy(true);
    setNotice("");
    try {
      await save();
      setNotice("Source saved.");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Source could not be saved"
      );
    } finally {
      setBusy(false);
    }
  }, [save]);
  const receiveProgress = useCallback(
    async (progress: ModuleBuildEvent) => {
      setEvent(progress);
      if ("log" in progress && progress.log) {
        setLogs((current) => `${current}\n${progress.log}`.slice(-65_536));
      }
      if (progress.phase !== "complete") {
        return;
      }
      update({ expected: progress.binding });
      const saved = await refresh();
      if (
        saved.binding?.contentId === progress.binding.contentId &&
        saved.binding.updatedAt === progress.binding.updatedAt
      ) {
        update({ baseline: saved.source, source: saved.source });
        setEditorRevision((current) => current + 1);
      }
      setTag(nextVersion(saved.releases));
      setBuiltId(progress.release.contentId);
      setNotice(`Release ${progress.release.tag} built. Starting preview…`);
    },
    [refresh, update]
  );
  const build = useCallback(async () => {
    const controller = new AbortController();
    lifetime.current = controller;
    setBuilding(true);
    setBusy(true);
    setNotice("");
    setLogs("");
    setEvent({ phase: "preparing" });
    try {
      const binding = await save(controller.signal);
      const stream = await worksApi().modules.build.call(
        { expected: binding, id: details.id, tag },
        { signal: controller.signal }
      );
      for await (const progress of stream) {
        await receiveProgress(progress);
      }
    } catch (error) {
      setEvent({
        message: controller.signal.aborted
          ? "Build cancelled."
          : errorMessage(error),
        phase: "failed",
      });
    } finally {
      lifetime.current = null;
      setBuilding(false);
      setBusy(false);
    }
  }, [save, details.id, tag, receiveProgress]);
  const discardDraft = useCallback(async () => {
    setBusy(true);
    try {
      const saved = await refresh();
      update({
        baseline: saved.source,
        conflicts: [],
        expected: saved.binding,
        source: saved.source,
      });
      setEditorRevision((current) => current + 1);
      setNotice("Loaded saved source.");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Saved source could not be loaded."
      );
    } finally {
      setBusy(false);
    }
  }, [refresh, update]);
  const changeTag = useCallback(
    (change: ChangeEvent<HTMLInputElement>) =>
      setTag(change.currentTarget.value),
    []
  );
  const cancelBuild = useCallback(() => lifetime.current?.abort(), []);
  return {
    baseline,
    build,
    building,
    builtId,
    busy,
    cancelBuild,
    changeTag,
    conflicts,
    dirty,
    discardDraft,
    edit,
    editorRevision,
    event,
    expected,
    logs,
    notice,
    path,
    proposals,
    saveSource,
    selectFile,
    source,
    tag,
  };
}
