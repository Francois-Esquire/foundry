import type { FileContents, FileEditChangeHandler } from "@pierre/diffs";
import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File, MultiFileDiff } from "@pierre/diffs/react";
import { type CSSProperties, useCallback, useMemo, useState } from "react";
import { useTheme } from "~/app/theme/theme";

const createEditor: EditorFactory<undefined, undefined> = (
  type,
  options,
  key
) => new Editor(type, options, key);
const acceptEdit = () => "accept" as const;
const codeStyle: CSSProperties = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "12px",
} as CSSProperties;

export function ModuleCode({
  path,
  contents,
  disabled,
  onChange,
}: {
  path: string;
  contents: string;
  disabled: boolean;
  onChange: (path: string, contents: string) => void;
}) {
  // Pierre owns the active document. Draft updates must not feed back into it.
  const [file] = useState<FileContents>(() => ({ contents, name: path }));
  const { resolvedTheme } = useTheme();
  const options = useMemo(
    () => ({
      disableFileHeader: true,
      theme: { dark: "pierre-dark", light: "pierre-light" } as const,
      themeType: resolvedTheme,
    }),
    [resolvedTheme]
  );
  const change = useCallback<FileEditChangeHandler<undefined, undefined>>(
    (event) => onChange(path, event.file.contents),
    [onChange, path]
  );
  return (
    <section
      aria-label="Editor"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/40"
    >
      <h2 className="shrink-0 border-border/40 border-b px-4 py-3 font-mono text-xs">
        {path}
      </h2>
      <div className="min-h-0 flex-1 overflow-auto" data-module-source>
        <EditProvider createEditor={createEditor}>
          <File
            edit={!disabled}
            file={file}
            onEditChange={change}
            onEditComplete={acceptEdit}
            options={options}
            style={codeStyle}
          />
        </EditProvider>
      </div>
    </section>
  );
}

export function ModuleFileDiff({
  path,
  before,
  after,
}: {
  path: string;
  before?: string;
  after?: string;
}) {
  const { resolvedTheme } = useTheme();
  const oldFile = useMemo(
    () => (before === undefined ? null : { contents: before, name: path }),
    [path, before]
  );
  const newFile = useMemo(
    () => (after === undefined ? null : { contents: after, name: path }),
    [path, after]
  );
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      theme: { dark: "pierre-dark", light: "pierre-light" } as const,
      themeType: resolvedTheme,
    }),
    [resolvedTheme]
  );
  if (oldFile && newFile) {
    return (
      <MultiFileDiff
        newFile={newFile}
        oldFile={oldFile}
        options={options}
        style={codeStyle}
      />
    );
  }
  if (newFile) {
    return (
      <MultiFileDiff
        newFile={newFile}
        oldFile={null}
        options={options}
        style={codeStyle}
      />
    );
  }
  if (oldFile) {
    return (
      <MultiFileDiff
        newFile={null}
        oldFile={oldFile}
        options={options}
        style={codeStyle}
      />
    );
  }
  return null;
}
