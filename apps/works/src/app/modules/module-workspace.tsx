import { Tabs } from "radix-ui";
import { useCallback, useMemo, useState } from "react";
import { Button } from "~/app/components/button";
import { Input } from "~/app/components/input";
import { SubNav } from "~/app/layout/context";
import { SidePanel, SidePanelHeader } from "~/app/layout/side-panel";
import type { AuthoringProposalFiles } from "~/shared/authoring";
import type { ModuleBuildEvent, ModuleDetails } from "~/shared/modules";
import { ModuleAccessPanel } from "./module-access";
import { ModuleChatPanel } from "./module-chat";
import { ModuleCode, ModuleFileDiff } from "./module-code";
import { ModulePreviewPanel } from "./module-preview";
import { ModuleSettingsPanel } from "./module-settings";
import { ModuleTree } from "./module-tree";
import type { ProposalConflict } from "./proposal";
import { useModuleChat } from "./use-module-chat";
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
const views = ["Source", "Changes", "Releases", "Access & settings"] as const;

function ConflictFile({
  conflict,
  resolve,
}: {
  conflict: ProposalConflict;
  resolve: (conflict: ProposalConflict, choice: "draft" | "proposal") => void;
}) {
  const keep = useCallback(
    () => resolve(conflict, "draft"),
    [conflict, resolve]
  );
  const take = useCallback(
    () => resolve(conflict, "proposal"),
    [conflict, resolve]
  );
  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-border/40">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="mr-auto truncate font-mono text-xs">
          {conflict.path}
        </span>
        <Button
          aria-label={`Keep my draft of ${conflict.path}`}
          onClick={keep}
          size="xs"
          variant="outline"
        >
          Keep my draft
        </Button>
        <Button
          aria-label={`Use the proposal for ${conflict.path}`}
          onClick={take}
          size="xs"
        >
          Use proposal
        </Button>
      </div>
      <ModuleFileDiff
        after={conflict.proposal ?? undefined}
        before={conflict.draft ?? undefined}
        path={conflict.path}
      />
    </div>
  );
}

export function ModuleWorkspace({
  details,
  refresh,
}: {
  details: ModuleDetails;
  refresh: () => Promise<ModuleDetails>;
}) {
  const [view, setView] = useState("Source");
  // New conflicts are resolved in Changes. Switch there in the same update
  // that adds them, so the chat never says "resolve them in Changes" in a
  // render where Changes is not showing them.
  const showChanges = useCallback(() => setView("Changes"), []);
  const editor = useModuleEditor(details, refresh, showChanges);
  const chat = useModuleChat(details.id, editor.proposals);
  const [review, setReview] = useState<
    ({ turnId: string } & AuthoringProposalFiles) | null
  >(null);
  const [reviewError, setReviewError] = useState("");
  const { proposal } = chat;
  const openReview = useCallback(
    async (turnId: string) => {
      setReviewError("");
      try {
        setReview({ turnId, ...(await proposal(turnId)) });
      } catch (error) {
        setReview(null);
        setReviewError(
          error instanceof Error
            ? error.message
            : "The proposal could not load."
        );
      }
      setView("Changes");
    },
    [proposal]
  );
  const closeReview = useCallback(() => setReview(null), []);
  const paths = useMemo(
    () => Object.keys(editor.source).sort(),
    [editor.source]
  );
  const changed = [...new Set([...Object.keys(editor.baseline), ...paths])]
    .sort()
    .filter((path) => editor.source[path] !== editor.baseline[path]);
  return (
    <div className="flex min-h-0 flex-1">
      <Tabs.Root
        className="flex min-h-0 min-w-0 flex-1 flex-col"
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
        <Tabs.Content
          className="flex min-h-0 flex-1 flex-col p-2"
          value="Source"
        >
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
          {editor.conflicts.length > 0 && (
            <section aria-label="Conflicts" className="mb-6">
              <h2 className="px-4 pt-2 pb-3 font-medium text-xs">
                Conflicts with chat proposals
              </h2>
              <p className="px-4 pb-3 text-muted-foreground text-xs">
                You and the agent changed these files differently. Each shows
                your draft as the old side and the proposal as the new side;
                choose one whole version.
              </p>
              {editor.conflicts.map((conflict) => (
                <ConflictFile
                  conflict={conflict}
                  key={`${conflict.turnId}:${conflict.path}`}
                  resolve={chat.resolveConflict}
                />
              ))}
            </section>
          )}
          {reviewError && (
            <p className="px-4 pb-3 text-destructive text-xs" role="alert">
              {reviewError}
            </p>
          )}
          {review && (
            <section aria-label="Proposal review" className="mb-6">
              <div className="flex items-center gap-2 px-4 pt-2 pb-3">
                <h2 className="mr-auto font-medium text-xs">
                  Proposed changes, against the draft the request started from
                </h2>
                <Button onClick={closeReview} size="xs" variant="ghost">
                  Close review
                </Button>
              </div>
              {Object.keys(review.proposal)
                .sort()
                .map((path) => (
                  <div
                    className="mb-3 overflow-hidden rounded-xl border border-border/40"
                    key={path}
                  >
                    <ModuleFileDiff
                      after={review.proposal[path] ?? undefined}
                      before={review.base[path] ?? undefined}
                      path={path}
                    />
                  </div>
                ))}
            </section>
          )}
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
        <Tabs.Content
          className="min-h-0 flex-1 overflow-auto p-6"
          value="Access & settings"
        >
          <div className="grid gap-8 lg:grid-cols-2">
            <ModuleAccessPanel moduleId={details.id} />
            <ModuleSettingsPanel moduleId={details.id} />
          </div>
        </Tabs.Content>
      </Tabs.Root>
      <ModuleChatPanel
        chat={chat}
        disabled={!editor.expected}
        onReview={openReview}
        onSend={chat.send}
      />
    </div>
  );
}
