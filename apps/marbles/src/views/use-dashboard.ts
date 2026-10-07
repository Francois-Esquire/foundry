import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { useAsyncAction } from "~/hooks/use-async-action";
import { useQuitGuard } from "~/hooks/use-quit-guard";
import {
  type CommandContext,
  capturesKeys,
  commandFor,
  footer,
} from "./dashboard-commands";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  resolveSelection,
} from "./dashboard-model";
import {
  type DashboardEvent,
  type DashboardViewKey,
  type InspectorTab,
  initialState,
  launchesDirectly,
  paneOf,
  reduce,
  visibleLists,
} from "./dashboard-state";
import type { CatalogSelection } from "./dashboard-tree";
import type { RunActions } from "./run-actions";
import { type AnswerHandler, useFeed } from "./use-feed";

export interface DashboardOptions {
  /** Cancel, pause, resume, and steer live runs; absent in previews. */
  readonly actions?: RunActions;
  /** Answer an open input entry; absent where nothing can resume the run. */
  readonly onAnswer?: AnswerHandler;
  readonly onClose: () => void;
  readonly onLaunch?: (name: string, input: unknown) => Promise<string>;
  /** Keys the dashboard leaves alone, for the preview's own controls. */
  readonly onShortcut?: (key: KeyEvent) => void;
  readonly snapshot: DashboardSnapshot;
}

/**
 * The dashboard's keyboard and its effects. State lives in `reduce`, keys in
 * the command table; this hook connects them to the host's callbacks.
 */
export function useDashboard({
  actions,
  onAnswer,
  onClose,
  onLaunch,
  onShortcut,
  snapshot,
}: DashboardOptions) {
  const [state, setState] = useState(() => initialState(snapshot));
  const send = (event: DashboardEvent) =>
    setState((previous) => reduce(previous, event, snapshot));
  const feed = useFeed(snapshot.feed, snapshot.workspaceId, onAnswer);
  const quit = useQuitGuard(onClose);
  const control = useAsyncAction();
  const starting = useAsyncAction();
  const resolved = resolveSelection(snapshot, state.selected);
  const form = onLaunch
    ? snapshot.definitions.find((item) => item.id === state.launching)
    : undefined;

  function launch(id: string) {
    const definition = snapshot.definitions.find((item) => item.id === id);
    if (!(onLaunch && definition)) {
      return;
    }
    starting.clear();
    if (!launchesDirectly(definition)) {
      send({ id, type: "launch-form" });
      return;
    }
    starting.run(async () => {
      send({ id: await onLaunch(id, undefined), type: "show-run" });
    });
  }

  function submitPrompt() {
    const { draft, prompt } = state;
    if (!(prompt && actions)) {
      return;
    }
    const text = draft.trim();
    if (prompt.kind === "steer" && !text) {
      return;
    }
    send({ type: "prompt" });
    control.run(() =>
      prompt.kind === "steer"
        ? actions.steer(prompt.runId, prompt.stepId, text)
        : actions.resume(prompt.runId, prompt.stepId, text || undefined)
    );
  }

  const context: CommandContext = {
    actions,
    canLaunch: onLaunch !== undefined,
    feed,
    resolved,
    state,
  };
  useKeyboard((key) => {
    // The argument form has the keyboard, quitting included.
    if (form || quit.handleKey(key)) {
      return;
    }
    const command = commandFor(key, context);
    if (!capturesKeys(context)) {
      onShortcut?.(key);
    }
    command?.run(
      { ...context, act: control.run, launch, quit: quit.ask, send },
      key
    );
  });

  return {
    ...visibleLists(state, snapshot),
    changeTab: (tab: InspectorTab) => send({ tab, type: "tab" }),
    clearFilters: () => send({ type: "clear-filters" }),
    /** Run controls in flight, and the last one's failure. */
    control,
    feed,
    filterRuns: (filter: CatalogSelection) => send({ filter, type: "filter" }),
    finishSearch: () => send({ open: false, type: "search" }),
    footer: footer(context),
    /** The definition whose argument form is showing. */
    form,
    goHome: () => send({ type: "home" }),
    /** A text field or overlay has the keys; panels show unfocused. */
    inputActive:
      state.searching ||
      state.help ||
      quit.quitting ||
      state.prompt !== undefined,
    inspect: (selection: DashboardSelection) =>
      send({ selection, type: "inspect" }),
    launch,
    leaveForm: () => send({ type: "launch-form" }),
    pane: paneOf(state),
    quit,
    resolved,
    setDraft: (value: string) => send({ type: "draft", value }),
    setQuery: (value: string) => send({ type: "query", value }),
    setView: (view: DashboardViewKey) => send({ type: "view", view }),
    showRun: (id: string) => send({ id, type: "show-run" }),
    /** A direct launch in flight, and its failure. */
    starting,
    state,
    submitPrompt,
    toggle: (selection: DashboardSelection) =>
      send({ selection, type: "toggle" }),
  };
}
