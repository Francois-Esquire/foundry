import { type ChangeEvent, type MouseEvent, useCallback } from "react";
import { vi } from "vitest";

// Exercise draft/router behavior here; native Electron tests exercise Pierre's DOM.
vi.mock("~/app/modules/module-code", () => ({
  ModuleCode: ({
    path,
    contents,
    disabled,
    onChange,
  }: {
    path: string;
    contents: string;
    disabled: boolean;
    onChange: (path: string, contents: string) => void;
  }) => {
    const change = useCallback(
      (event: ChangeEvent<HTMLTextAreaElement>) =>
        onChange(path, event.currentTarget.value),
      [onChange, path]
    );
    return (
      <section aria-label="Editor">
        <textarea
          aria-label="Source code"
          disabled={disabled}
          onChange={change}
          value={contents}
        />
      </section>
    );
  },
  ModuleFileDiff: ({
    path,
    before,
    after,
  }: {
    path: string;
    before?: string;
    after?: string;
  }) => (
    <section aria-label={`Changes in ${path}`}>
      <pre>{before}</pre>
      <pre>{after}</pre>
    </section>
  ),
}));
vi.mock("~/app/modules/module-tree", () => ({
  ModuleTree: ({
    paths,
    onSelect,
  }: {
    paths: string[];
    onSelect: (path: string) => void;
  }) => {
    const select = useCallback(
      (event: MouseEvent<HTMLButtonElement>) =>
        onSelect(event.currentTarget.dataset.path ?? ""),
      [onSelect]
    );
    return (
      <div>
        {paths.map((path) => (
          <button data-path={path} key={path} onClick={select} type="button">
            {path}
          </button>
        ))}
      </div>
    );
  },
}));
