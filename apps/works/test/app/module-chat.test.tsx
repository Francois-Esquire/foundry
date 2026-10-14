import "../helpers/mock-module-source";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "@foundry.sh/marbles/engine";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LayoutProvider, SubNavSlot } from "~/app/layout/context";
import { ModuleWorkspace } from "~/app/modules/module-workspace";
import { ThemeProvider } from "~/app/theme/theme";
import type {
  AuthoringTurnRun,
  AuthoringTurnRunner,
} from "~/main/modules/authoring/agent";
import { moduleDirectory } from "~/main/modules/local-library";
import type { ModuleDetails } from "~/shared/modules";
import { authoringFixture } from "../helpers/authoring";
import { fakeApi, openFakeVault } from "../helpers/fake-api";
import { inlineExecution } from "../helpers/inline-execution";

const APP = "packages/app/src/App.tsx";
const OTHER = "packages/app/src/index.css";
const EMPTY_CHAT = /Ask for a change to this module/;
const APPLIED_ONE = /Applied 1 file to your draft/;
const ONE_CONFLICT = /1 file conflict with your draft/;
const SOURCE_TAB = /Source/;
const CHANGES_TAB = /Changes/;

const active = vi.hoisted(() => ({
  api: undefined as ReturnType<typeof fakeApi> | undefined,
}));
vi.mock("~/app/api/client", () => ({ worksApi: () => active.api }));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Hand each turn to the test, which decides what the agent does. */
function scriptedRunner() {
  const turns: {
    run: AuthoringTurnRun;
    finish: () => void;
    fail: (error: Error) => void;
  }[] = [];
  const waiting: ((turn: (typeof turns)[number]) => void)[] = [];
  const runner: AuthoringTurnRunner = (run) =>
    new Promise<void>((resolve, reject) => {
      run.signal.addEventListener("abort", () => reject(run.signal.reason), {
        once: true,
      });
      const turn = { fail: reject, finish: resolve, run };
      turns.push(turn);
      waiting.shift()?.(turn);
    });
  return {
    next() {
      const ready = turns.shift();
      if (ready) {
        return Promise.resolve(ready);
      }
      return new Promise<(typeof turns)[number]>((resolve) =>
        waiting.push((turn) => {
          turns.splice(turns.indexOf(turn), 1);
          resolve(turn);
        })
      );
    },
    runner,
  };
}

async function writeGuest(run: AuthoringTurnRun, file: string, text: string) {
  await run.container.files.writeFile(`/workspace/${file}`, text);
}

function emit(run: AuthoringTurnRun, ...events: SessionEvent[]) {
  for (const event of events) {
    run.onEvent(event);
  }
}

async function fixture() {
  const agent = scriptedRunner();
  const authoring = await authoringFixture({
    execution: inlineExecution,
    runner: agent.runner,
  });
  active.api = fakeApi(await openFakeVault(), authoring.library, {
    authoring: authoring.service,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const refresh = vi.fn(async () => {
    const saved = await authoring.library.details(authoring.module.id);
    if (!saved) {
      throw new Error("Module missing");
    }
    return saved;
  });
  const tree = (details: ModuleDetails) => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <LayoutProvider>
          <SubNavSlot />
          <ModuleWorkspace
            details={details}
            key={details.id}
            refresh={refresh}
          />
        </LayoutProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
  const rendered = render(tree(authoring.details));
  await screen.findByText(EMPTY_CHAT);
  return { ...authoring, agent, rendered, tree };
}

function chatPane() {
  return within(screen.getByRole("complementary", { name: "Module chat" }));
}

async function ask(prompt: string) {
  fireEvent.change(chatPane().getByLabelText("Message"), {
    target: { value: prompt },
  });
  fireEvent.keyDown(chatPane().getByLabelText("Message"), { key: "Enter" });
  await chatPane().findByText(prompt);
}

function typeInto(file: string, text: string) {
  fireEvent.click(screen.getByRole("button", { name: file }));
  fireEvent.change(screen.getByLabelText("Source code"), {
    target: { value: text },
  });
}

it("streams a turn's progress, shows denied attempts, and accepts disjoint edits into the Draft", async () => {
  const { agent, library, module } = await fixture();
  typeInto(OTHER, "my readme");
  await ask("Make it say hello");
  const turn = await agent.next();
  // The Draft the turn works on includes the unsaved edit.
  expect(
    new TextDecoder().decode(
      await turn.run.container.files.readFile(`/workspace/${OTHER}`)
    )
  ).toBe("my readme");
  emit(
    turn.run,
    { delta: "Updating the app", type: "text-delta" },
    {
      input: {},
      name: "create_automation",
      toolCallId: "t1",
      type: "tool-call",
    },
    {
      output: { approved: false, reason: "Denied by harness profile." },
      toolCallId: "t1",
      type: "tool-result",
    }
  );
  // Each event reaches the chat on its own; wait for each one.
  await chatPane().findByText("Updating the app");
  await chatPane().findByText(
    "create_automation · denied (Denied by harness profile.)"
  );
  expect(chatPane().getByText("Working…")).toBeDefined();
  await writeGuest(turn.run, APP, "export const App = () => 'hello';");
  // The user keeps typing in another file while the agent works.
  typeInto(OTHER, "my readme, still typing");
  turn.finish();
  const card = await chatPane().findByRole("region", {
    name: "Proposed changes",
  });
  expect(within(card).getByText(APP)).toBeDefined();
  fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
  await chatPane().findByText(APPLIED_ONE);
  // The applied status comes back from main as its own event.
  await within(card).findByText("Applied to your draft.");
  fireEvent.click(screen.getByRole("button", { name: APP }));
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).toBe("export const App = () => 'hello';");
  fireEvent.click(screen.getByRole("button", { name: OTHER }));
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).toBe("my readme, still typing");
  // Nothing was saved for the user; saving is explicit.
  expect((await library.details(module.id))?.source[APP]).not.toContain(
    "hello"
  );
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await screen.findByText("Source saved.");
  const saved = await library.details(module.id);
  expect(saved?.source[APP]).toBe("export const App = () => 'hello';");
  expect(saved?.source[OTHER]).toBe("my readme, still typing");
});

it("keeps an accepted proposal on the binding a save made while accepting", async () => {
  const { agent, details, rendered, service, tree } = await fixture();
  await ask("Change the app");
  const turn = await agent.next();
  await writeGuest(turn.run, APP, "agent version");
  turn.finish();
  const card = await chatPane().findByRole("region", {
    name: "Proposed changes",
  });
  // Main has checked the saved binding; the answer is still on its way.
  const { promise: answered, resolve: answer } = Promise.withResolvers<void>();
  const accept = service.accept.bind(service);
  vi.spyOn(service, "accept").mockImplementation(async (...args) => {
    const result = await accept(...args);
    await answered;
    return result;
  });
  fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
  await vi.waitFor(() => expect(service.accept).toHaveBeenCalled());
  typeInto(OTHER, "saved meanwhile");
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await screen.findByText("Source saved.");
  answer();
  await chatPane().findByText(APPLIED_ONE);
  // The Draft kept for the next launch is bound to the save, not the
  // revision the accept started from, so saving it later succeeds.
  rendered.unmount();
  render(tree(details));
  await screen.findByText(
    "Recovered your local draft. Save it before building."
  );
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await screen.findByText("Source saved.");
});

it("asks before the window closes over unsaved edits", async () => {
  await fixture();
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  typeInto(APP, "unsaved");
  const dirty = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
});

it("holds overlapping edits as a whole-file conflict with both versions", async () => {
  const { agent } = await fixture();
  await ask("Change the app");
  const turn = await agent.next();
  typeInto(APP, "my version");
  await writeGuest(turn.run, APP, "agent version");
  turn.finish();
  const card = await chatPane().findByRole("region", {
    name: "Proposed changes",
  });
  // In every render, the chat sends the user to Changes only once Changes
  // shows the conflicts.
  const early: string[] = [];
  const observer = new MutationObserver(() => {
    if (
      screen.queryByText(ONE_CONFLICT) &&
      !screen.queryByRole("region", { name: "Conflicts" })
    ) {
      early.push("status before conflicts");
    }
  });
  observer.observe(document.body, {
    characterData: true,
    childList: true,
    subtree: true,
  });
  fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
  await chatPane().findByText(ONE_CONFLICT);
  observer.disconnect();
  expect(early).toEqual([]);
  const versions = within(
    screen.getByRole("region", { name: "Conflicts" })
  ).getByRole("region", { name: `Changes in ${APP}` });
  expect(within(versions).getByText("my version")).toBeDefined();
  expect(within(versions).getByText("agent version")).toBeDefined();
  // Nothing overwrote the Draft.
  fireEvent.mouseDown(screen.getByRole("tab", { name: SOURCE_TAB }));
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).toBe("my version");
  fireEvent.mouseDown(screen.getByRole("tab", { name: CHANGES_TAB }));
  fireEvent.click(
    within(screen.getByRole("region", { name: "Conflicts" })).getByRole(
      "button",
      { name: `Use the proposal for ${APP}` }
    )
  );
  await chatPane().findByText(
    "All conflicts resolved. Save to keep the result."
  );
  expect(screen.queryByRole("region", { name: "Conflicts" })).toBeNull();
  await within(card).findByText("Applied to your draft.");
});

it("refuses a proposal after saved source moved and offers compare and manual resolution", async () => {
  const { agent } = await fixture();
  await ask("Change the app");
  const turn = await agent.next();
  await writeGuest(turn.run, APP, "agent version");
  turn.finish();
  const card = await chatPane().findByRole("region", {
    name: "Proposed changes",
  });
  typeInto(OTHER, "saved meanwhile");
  fireEvent.click(screen.getByRole("button", { name: "Save source" }));
  await screen.findByText("Source saved.");
  fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
  expect((await within(card).findByRole("alert")).textContent).toContain(
    "Saved source changed since this request was sent"
  );
  fireEvent.click(screen.getByRole("button", { name: APP }));
  expect(
    (screen.getByLabelText("Source code") as HTMLTextAreaElement).value
  ).not.toBe("agent version");
  fireEvent.click(within(card).getByRole("button", { name: "Compare" }));
  const review = await screen.findByRole("region", { name: "Proposal review" });
  expect(within(review).getByText("agent version")).toBeDefined();
  fireEvent.click(
    within(card).getByRole("button", { name: "Resolve by hand" })
  );
  const conflicts = await screen.findByRole("region", { name: "Conflicts" });
  fireEvent.click(
    within(conflicts).getByRole("button", { name: `Keep my draft of ${APP}` })
  );
  await chatPane().findByText(
    "All conflicts resolved. Save to keep the result."
  );
});

it("routes a question to the chat that owns the turn", async () => {
  const { agent } = await fixture();
  await ask("Pick a color");
  const turn = await agent.next();
  const answered = turn.run.question({
    questions: [
      {
        id: "color",
        options: [{ label: "Teal" }, { label: "Red" }],
        question: "Which color?",
      },
    ],
    sessionId: "s",
    signal: turn.run.signal,
    toolCallId: "ask-1",
  });
  const form = await chatPane().findByRole("form", { name: "Agent question" });
  fireEvent.click(within(form).getByLabelText("Teal"));
  fireEvent.click(within(form).getByRole("button", { name: "Answer" }));
  await expect(answered).resolves.toEqual({
    answers: { color: ["Teal"] },
    outcome: "answered",
  });
  await chatPane().findByText("Answered.");
  turn.finish();
  await chatPane().findByText("Finished without changing source files.");
});

it("answers a free-text question with what was typed, even when it allows several answers", async () => {
  const { agent } = await fixture();
  await ask("Name it");
  const turn = await agent.next();
  const answered = turn.run.question({
    questions: [{ id: "name", multiSelect: true, question: "Which name?" }],
    sessionId: "s",
    signal: turn.run.signal,
    toolCallId: "ask-1",
  });
  const form = await chatPane().findByRole("form", { name: "Agent question" });
  const field = within(form).getByLabelText("Which name?");
  fireEvent.change(field, { target: { value: "T" } });
  fireEvent.change(field, { target: { value: "Teal" } });
  fireEvent.click(within(form).getByRole("button", { name: "Answer" }));
  await expect(answered).resolves.toEqual({
    answers: { name: ["Teal"] },
    outcome: "answered",
  });
  turn.finish();
});

it("cancels a request, and leaving the Module neither cancels nor loses it", async () => {
  const { agent, details, rendered, tree } = await fixture();
  await ask("First");
  const first = await agent.next();
  rendered.unmount();
  const again = render(tree(details));
  await screen.findByText("First");
  expect(first.run.signal.aborted).toBe(false);
  expect(chatPane().getByText("Working…")).toBeDefined();
  // Streaming goes on after coming back, each delta shown once.
  emit(first.run, { delta: "Still here.", type: "text-delta" });
  await chatPane().findByText("Still here.");
  expect(chatPane().getAllByText("Still here.")).toHaveLength(1);
  fireEvent.click(chatPane().getByRole("button", { name: "Cancel request" }));
  await chatPane().findByText("Cancelled.");
  expect(first.run.signal.aborted).toBe(true);
  again.unmount();
});

it("shows unfinished work from an earlier run of Works as interrupted", async () => {
  const { agent, details, directory, module, open, rendered, service, tree } =
    await fixture();
  await ask("Before the restart");
  const turn = await agent.next();
  const turnId = (await service.conversation(module.id)).turns.at(-1)?.id ?? "";
  turn.run
    .question({
      questions: [{ id: "q", question: "Still there?" }],
      sessionId: "s",
      signal: turn.run.signal,
      toolCallId: "ask-1",
    })
    .catch(() => undefined);
  await chatPane().findByRole("form", { name: "Agent question" });
  rendered.unmount();
  // A question the user can see is already on disk, so the process may go
  // away now.
  expect(
    await readFile(
      path.join(
        directory,
        moduleDirectory(module.id),
        "turns",
        `${turnId}.json`
      ),
      "utf8"
    )
  ).toContain('"kind":"question"');
  // A new main process over the same authoring state.
  active.api = fakeApi(await openFakeVault(), undefined, {
    authoring: open(),
  });
  render(tree(details));
  await screen.findByText("Works closed before this request finished.");
  expect(
    screen.getByText("Not answered: Works closed while the agent waited.")
  ).toBeDefined();
  expect(screen.queryByRole("form", { name: "Agent question" })).toBeNull();
  turn.fail(new Error("stopped"));
});
