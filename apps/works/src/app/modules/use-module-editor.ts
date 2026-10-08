import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { worksApi } from "~/app/api/client";
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
  refresh: () => Promise<ModuleDetails>
) {
  const [initial] = useState(() => initialDraft(details));
  const [source, setSource] = useState(initial.source);
  const [baseline, setBaseline] = useState(details.source);
  const [expected, setExpected] = useState(initial.expected);
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
  const edit = useCallback(
    (file: string, contents: string) => {
      if (!expected) {
        return;
      }
      const next = { ...source, [file]: contents };
      setSource(next);
      try {
        writeModuleDraft(details.id, next, expected);
      } catch {
        setNotice(
          "Your draft could not be stored locally. Save before leaving this module."
        );
      }
    },
    [expected, source, details.id]
  );
  const selectFile = useCallback((file: string) => setSelected(file), []);
  const save = useCallback(
    async (signal?: AbortSignal): Promise<ModuleSourceRevision> => {
      if (!expected) {
        throw new Error("This module has no editable source");
      }
      if (!dirty) {
        return expected;
      }
      const binding = await worksApi().modules.saveSource.call(
        { expected, id: details.id, source },
        { signal }
      );
      setExpected(binding);
      setBaseline(source);
      try {
        clearModuleDraft(details.id);
      } catch {
        setNotice("Source saved, but the local draft could not be cleared.");
      }
      return binding;
    },
    [expected, dirty, details.id, source]
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
      setExpected(progress.binding);
      const saved = await refresh();
      if (
        saved.binding?.contentId === progress.binding.contentId &&
        saved.binding.updatedAt === progress.binding.updatedAt
      ) {
        setSource(saved.source);
        setEditorRevision((current) => current + 1);
        setBaseline(saved.source);
      }
      setTag(nextVersion(saved.releases));
      setBuiltId(progress.release.contentId);
      setNotice(`Release ${progress.release.tag} built. Starting preview…`);
    },
    [refresh]
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
      setSource(saved.source);
      setEditorRevision((current) => current + 1);
      setBaseline(saved.source);
      setExpected(saved.binding);
      clearModuleDraft(details.id);
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
  }, [details.id, refresh]);
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
    dirty,
    discardDraft,
    edit,
    editorRevision,
    event,
    expected,
    logs,
    notice,
    path,
    saveSource,
    selectFile,
    source,
    tag,
  };
}
