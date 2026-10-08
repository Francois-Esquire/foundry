import { Tabs } from "radix-ui";
import { useMemo, useState } from "react";
import { Button } from "~/app/components/button";
import { Input } from "~/app/components/input";
import { SubNav } from "~/app/layout/context";
import { SidePanel, SidePanelHeader } from "~/app/layout/side-panel";
import type { ModuleBuildEvent, ModuleDetails } from "~/shared/modules";
import { ModuleCode, ModuleFileDiff } from "./module-code";
import { ModulePreviewPanel } from "./module-preview";
import { ModuleTree } from "./module-tree";
import { useModuleEditor } from "./use-module-editor";

function buildStatus(event: ModuleBuildEvent) {
  if (event.phase === "failed") {
    return event.message;
  }
  if (event.phase === "complete") {
    return "Build complete";
  }
  return `Build: ${event.phase}…`;
}
const views = ["Source", "Changes", "Releases"] as const;

export function ModuleWorkspace({
  details,
  refresh,
}: {
  details: ModuleDetails;
  refresh: () => Promise<ModuleDetails>;
}) {
  const editor = useModuleEditor(details, refresh);
  const [view, setView] = useState("Source");
  const pathKey = JSON.stringify(Object.keys(editor.source).sort());
  const paths = useMemo<string[]>(() => JSON.parse(pathKey), [pathKey]);
  const changed = [...new Set([...Object.keys(editor.baseline), ...paths])]
    .sort()
    .filter((path) => editor.source[path] !== editor.baseline[path]);
  return (
    <Tabs.Root
      className="flex min-h-0 flex-1 flex-col"
      onValueChange={setView}
      value={view}
    >
      {view === "Source" && (
        <SubNav>
          <SidePanel>
            <SidePanelHeader title="Files" />
            <div className="min-h-0 flex-1">
              <ModuleTree
                onSelect={editor.selectFile}
                paths={paths}
                selected={editor.path}
              />
            </div>
          </SidePanel>
        </SubNav>
      )}
      <div className="flex shrink-0 items-center gap-4 border-border/40 border-b px-6 pb-3">
        <Tabs.List
          aria-label="Module management"
          className="mr-auto flex gap-4"
        >
          {views.map((name) => (
            <Tabs.Trigger
              className="border-transparent border-b-2 py-2 font-medium text-muted-foreground text-xs outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:border-foreground data-[state=active]:text-foreground"
              key={name}
              value={name}
            >
              {name}
              {name === "Changes" && changed.length > 0
                ? ` (${changed.length})`
                : ""}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <span className="text-muted-foreground text-xs">
          {editor.dirty ? "Unsaved changes" : "Saved source"}
        </span>
        {editor.dirty && (
          <Button
            disabled={editor.busy}
            onClick={editor.discardDraft}
            size="sm"
            variant="ghost"
          >
            Discard draft
          </Button>
        )}
        <Button
          disabled={editor.busy || !editor.dirty || !editor.expected}
          onClick={editor.saveSource}
          size="sm"
          variant="outline"
        >
          Save source
        </Button>
      </div>
      {editor.notice && (
        <p
          aria-live="polite"
          className="shrink-0 px-6 py-3 text-xs"
          role="status"
        >
          {editor.notice}
        </p>
      )}
      <Tabs.Content className="flex min-h-0 flex-1 flex-col p-2" value="Source">
        {editor.path ? (
          <ModuleCode
            contents={editor.source[editor.path] ?? ""}
            disabled={editor.busy || !editor.expected}
            key={`${editor.path}:${editor.editorRevision}`}
            onChange={editor.edit}
            path={editor.path}
          />
        ) : (
          <p className="p-6 text-sm">This module has no authored source.</p>
        )}
      </Tabs.Content>
      <Tabs.Content
        className="min-h-0 flex-1 overflow-auto p-2"
        value="Changes"
      >
        {changed.length === 0 ? (
          <p className="p-6 text-muted-foreground text-sm">
            No unsaved changes.
          </p>
        ) : (
          changed.map((path) => (
            <div
              className="mb-3 overflow-hidden rounded-xl border border-border/40"
              key={path}
            >
              <ModuleFileDiff
                after={editor.source[path]}
                before={editor.baseline[path]}
                path={path}
              />
            </div>
          ))
        )}
      </Tabs.Content>
      <Tabs.Content
        className="flex min-h-0 flex-1 flex-col gap-3 p-6"
        value="Releases"
      >
        <div className="flex shrink-0 items-center gap-3">
          <label className="text-xs" htmlFor="build-version">
            Version
          </label>
          <Input
            className="h-8 w-24 text-xs"
            disabled={editor.busy || !editor.expected}
            id="build-version"
            onChange={editor.changeTag}
            value={editor.tag}
          />
          <Button
            disabled={editor.busy || !editor.expected || !editor.tag.trim()}
            onClick={editor.build}
            size="sm"
          >
            Build &amp; preview
          </Button>
          {editor.building && (
            <Button onClick={editor.cancelBuild} size="sm" variant="outline">
              Cancel build
            </Button>
          )}
        </div>
        <p className="shrink-0 text-muted-foreground text-xs">
          Builds save the working source and run in a sandbox. Opening the app
          runs the latest built release.
        </p>
        {editor.event && (
          <div aria-live="polite" className="shrink-0 text-xs" role="status">
            <p>{buildStatus(editor.event)}</p>
            {editor.logs && (
              <details className="mt-2">
                <summary>Build output</summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
                  {editor.logs}
                </pre>
              </details>
            )}
          </div>
        )}
        <ModulePreviewPanel
          id={details.id}
          initialContentId={editor.builtId}
          key={`${details.id}:${editor.builtId ?? "saved"}`}
          releases={details.releases}
        />
      </Tabs.Content>
    </Tabs.Root>
  );
}
