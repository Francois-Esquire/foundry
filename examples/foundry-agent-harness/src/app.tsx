import type { ScrollBoxRenderable } from "@opentui/core";
import { SyntaxStyle } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatMessage } from "@/components/ui/chat-message";
import { ChatThread } from "@/components/ui/chat-thread";
import { Panel } from "@/components/ui/panel";
import { Tabs } from "@/components/ui/tabs";
import { ToolCall } from "@/components/ui/tool-call";
import type { Context, Run, Thread } from "@/harness";
import { useTheme } from "@/hooks/use-theme";

const SIDE = 42;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ICONS = { error: "✗", pending: "○", running: "", success: "✓" };
const FENCE_GAPS = /\n(\n```)|(?<=```\n)\n/g;
const EXAMPLES = [
  "Read package.json here and explain how to run this example.",
  "List the source files here and say what each one is for.",
];

function compact(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

function useFrame(active: boolean): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setTick((value) => value + 1), 80);
    return () => clearInterval(timer);
  }, [active]);
  return FRAMES[tick % FRAMES.length] ?? "";
}

function Row({
  children,
  color,
  icon,
  note,
}: {
  readonly children: string;
  readonly color: string;
  readonly icon: string;
  readonly note?: string;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="row" gap={1}>
      <text fg={color}>{icon}</text>
      <box flexDirection="column" flexShrink={1}>
        <text fg={color}>{children}</text>
        {note ? <text fg={theme.colors.mutedForeground}>{note}</text> : null}
      </box>
    </box>
  );
}

function Hint({ children }: { readonly children: ReactNode }) {
  const theme = useTheme();
  return <text fg={theme.colors.mutedForeground}>{children}</text>;
}

function Todos({
  frame,
  thread,
}: {
  readonly frame: string;
  readonly thread: Thread;
}) {
  const theme = useTheme();
  const colors = {
    error: theme.colors.error,
    pending: theme.colors.mutedForeground,
    running: theme.colors.primary,
    success: theme.colors.success,
  };
  if (thread.phase === "planning") {
    return (
      <Row color={theme.colors.primary} icon={frame}>
        Planning the goal into to-dos
      </Row>
    );
  }
  if (thread.todos.length === 0) {
    return <Hint>No to-dos yet. A goal is planned into two to four.</Hint>;
  }
  return (
    <>
      {thread.todos.map((todo) => (
        <Row
          color={colors[todo.status]}
          icon={ICONS[todo.status] || frame}
          key={todo.id}
          note={todo.added ? "added by the worker" : undefined}
        >
          {todo.title}
        </Row>
      ))}
    </>
  );
}

function Notes({ thread }: { readonly thread: Thread }) {
  const theme = useTheme();
  if (!thread.notes) {
    return <Hint>Nothing kept yet. Each goal is saved as one version.</Hint>;
  }
  return (
    <>
      <text>
        <b>Agent harness notes</b>
      </text>
      <Hint>{`version ${thread.notes.version} · ${thread.notes.versions} kept`}</Hint>
      <box flexDirection="column" marginTop={1}>
        {thread.notes.files.map((file) => (
          <Row
            color={theme.colors.foreground}
            icon="▪"
            key={file.path}
            note={file.path}
          >
            {file.title}
          </Row>
        ))}
      </box>
    </>
  );
}

function Skills({ context }: { readonly context: Context }) {
  const theme = useTheme();
  if (context.skills.length === 0) {
    return <Hint>No skills in .claude/skills here.</Hint>;
  }
  return (
    <>
      {context.skills.map((skill) => (
        <Row
          color={theme.colors.foreground}
          icon="◆"
          key={skill.name}
          note={skill.description}
        >
          {skill.name}
        </Row>
      ))}
      <box marginTop={1}>
        <Hint>From .claude/skills. The worker has these and no others.</Hint>
      </box>
    </>
  );
}

function Servers({ context }: { readonly context: Context }) {
  const theme = useTheme();
  return (
    <>
      {context.servers.map((server) => (
        <box flexDirection="column" key={server.name}>
          <Row
            color={theme.colors.foreground}
            icon="◆"
            note={server.description}
          >
            {server.name}
          </Row>
          {server.tools.map((tool) => (
            <box key={tool.name} paddingLeft={2}>
              <Row color={theme.colors.accent} icon="›" note={tool.description}>
                {tool.name}
              </Row>
            </box>
          ))}
        </box>
      ))}
      <box marginTop={1}>
        <Hint>
          Added by the harness. Connectors on your Claude account load too.
        </Hint>
      </box>
    </>
  );
}

function Welcome() {
  const theme = useTheme();
  return (
    <box flexDirection="column" gap={1}>
      <text>Give the harness a goal. It will:</text>
      <box flexDirection="column">
        <text> 1. plan the goal into a short to-do list</text>
        <text> 2. work through each to-do with Claude Code</text>
        <text> 3. keep the results as one artifact version</text>
      </box>
      <Hint>Try one of these:</Hint>
      <box flexDirection="column">
        {EXAMPLES.map((example) => (
          <text fg={theme.colors.accent} key={example}>{`  ${example}`}</text>
        ))}
      </box>
    </box>
  );
}

function Conversation({
  thread,
  width,
}: {
  readonly thread: Thread;
  readonly width: number;
}) {
  const theme = useTheme();
  const style = useMemo(
    () =>
      SyntaxStyle.fromStyles({
        conceal: { fg: theme.colors.mutedForeground },
        default: { fg: theme.colors.foreground },
        "markup.heading": { bold: true, fg: theme.colors.primary },
        "markup.link": { fg: theme.colors.info, underline: true },
        "markup.list": { fg: theme.colors.accent },
        "markup.raw": { fg: theme.colors.warning },
        "markup.raw.block": { fg: theme.colors.info },
        "markup.strong": { bold: true },
      }),
    [theme]
  );
  if (thread.messages.length === 0) {
    return <Welcome />;
  }
  const tasks = thread.messages.filter((message) => message.kind === "task");
  return (
    <ChatThread>
      {thread.messages.map((message, index) => {
        const empty = message.text === "" && message.tools.length === 0;
        const number = tasks.indexOf(message) + 1;
        return (
          <ChatMessage
            key={`${index}-${message.kind}`}
            name={
              message.kind === "task"
                ? `Task ${number} · ${message.title}`
                : message.title
            }
            sender={
              ({ error: "error", goal: "user", task: "assistant" } as const)[
                message.kind
              ]
            }
            streaming={message.streaming}
          >
            {empty ? null : (
              <box flexDirection="column">
                {message.tools.map((tool) => (
                  <box flexDirection="column" key={tool.id}>
                    <box flexDirection="row" gap={1}>
                      <ToolCall
                        collapsible={false}
                        name={tool.name}
                        status={tool.status}
                      />
                      <Hint>{tool.detail.slice(0, width - 24)}</Hint>
                    </box>
                    {tool.error ? (
                      <Hint>{`  ${tool.error.slice(0, width - 8)}`}</Hint>
                    ) : null}
                  </box>
                ))}
                <markdown
                  conceal
                  content={message.text.replace(FENCE_GAPS, "$1")}
                  syntaxStyle={style}
                />
              </box>
            )}
          </ChatMessage>
        );
      })}
    </ChatThread>
  );
}

export function App({
  context,
  initial,
  run,
}: {
  readonly context: Context;
  readonly initial: Thread;
  readonly run: Run;
}) {
  const theme = useTheme();
  const { height, width } = useTerminalDimensions();
  const [thread, setThread] = useState(initial);
  const [goal, setGoal] = useState("");
  const scroll = useRef<ScrollBoxRenderable>(null);
  const busy = thread.phase !== "idle";
  const frame = useFrame(busy);
  const body = height - 4;
  const done = thread.todos.filter((todo) => todo.status === "success").length;
  const room = width - SIDE - context.model.length - 29;
  const title =
    thread.title.length > room
      ? `${thread.title.slice(0, Math.max(room - 1, 0))}…`
      : thread.title;

  const submit = useCallback(() => {
    if (busy || goal.trim() === "") {
      return;
    }
    setGoal("");
    run(goal.trim(), setThread);
  }, [busy, goal, run]);

  useKeyboard((key) => {
    if (key.name === "pageup" || key.name === "pagedown") {
      scroll.current?.scrollBy(key.name === "pageup" ? -(body - 6) : body - 6);
    }
  });

  return (
    <box flexDirection="column" height={height} width={width}>
      <box flexDirection="row">
        <box flexDirection="column" height={body} width={SIDE}>
          <Tabs
            borderStyle="rounded"
            tabBarPaddingX={1}
            tabs={[
              {
                content: <Todos frame={frame} thread={thread} />,
                key: "todos",
                label: `To-dos ${done}/${thread.todos.length}`,
              },
              {
                content: <Notes thread={thread} />,
                key: "notes",
                label: "Notes",
              },
              {
                content: <Skills context={context} />,
                key: "skills",
                label: `Skills ${context.skills.length}`,
              },
              {
                content: <Servers context={context} />,
                key: "mcp",
                label: `MCP ${context.servers.length}`,
              },
            ]}
          />
        </box>
        <box flexDirection="column" height={body} width={width - SIDE}>
          <box flexDirection="row" gap={1} paddingLeft={1}>
            <text fg={theme.colors.primary}>
              <b>Foundry Agent Harness</b>
            </text>
            <Hint>{`· ${title} · ${context.model}`}</Hint>
          </box>
          <Panel height={body - 1} width={width - SIDE}>
            <scrollbox
              contentOptions={{ paddingRight: 1 }}
              height={body - 3}
              ref={scroll}
              stickyScroll
              stickyStart="bottom"
            >
              <Conversation thread={thread} width={width - SIDE} />
            </scrollbox>
          </Panel>
        </box>
      </box>
      <Panel width={width}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.colors.primary}>
            <b>{busy ? frame : "›"}</b>
          </text>
          <input
            flexGrow={1}
            focused
            onInput={setGoal}
            onSubmit={submit}
            placeholder={
              busy
                ? "Working. The next goal can go in when this one is done."
                : "Give the harness a goal"
            }
            value={goal}
          />
        </box>
      </Panel>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Hint>{`${compact(thread.input)} in · ${compact(thread.output)} out`}</Hint>
        <Hint>· Enter run · Tab panel · PgUp/PgDn scroll · Ctrl+C quit</Hint>
      </box>
    </box>
  );
}
