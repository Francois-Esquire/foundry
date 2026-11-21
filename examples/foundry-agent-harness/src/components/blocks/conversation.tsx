import { memo } from "react";
import { Reply } from "@/components/blocks/reply";
import { ToolRow } from "@/components/blocks/tool-row";
import { Welcome } from "@/components/blocks/welcome";
import { ChatMessage } from "@/components/ui/chat-message";
import { ChatThread } from "@/components/ui/chat-thread";
import type { Clock } from "@/model/screen";
import type { Message } from "@/model/thread";

const SENDERS = { error: "error", goal: "user", task: "assistant" } as const;

function numbered(messages: readonly Message[]) {
  let tasks = 0;
  return messages.map((message, index) => {
    tasks += message.kind === "task" ? 1 : 0;
    return {
      key: `${index}-${message.kind}`,
      message,
      name:
        message.kind === "task"
          ? `Task ${tasks} · ${message.title}`
          : message.title,
    };
  });
}

const STILL: Clock = { frame: 0, now: 0 };

function isLive(message: Message): boolean {
  return (
    message.streaming || message.tools.some((tool) => tool.status === "running")
  );
}

function MessageBody({
  clock,
  message,
}: {
  readonly clock: Clock;
  readonly message: Message;
}) {
  if (message.text === "" && message.tools.length === 0) {
    return null;
  }
  return (
    <box flexDirection="column">
      {message.tools.map((tool) => (
        <ToolRow clock={clock} key={tool.id} tool={tool} />
      ))}
      <Reply
        key={message.streaming ? "streaming" : "finished"}
        markdown={message.text}
        streaming={message.streaming}
      />
    </box>
  );
}

function MessageEntry({
  clock,
  message,
  name,
}: {
  readonly clock: Clock;
  readonly message: Message;
  readonly name: string;
}) {
  return (
    <ChatMessage
      name={name}
      sender={SENDERS[message.kind]}
      streaming={message.streaming}
    >
      <MessageBody clock={clock} message={message} />
    </ChatMessage>
  );
}

const ConversationMessage = memo(MessageEntry);

export function Conversation({
  clock,
  messages,
}: {
  readonly clock: Clock;
  readonly messages: readonly Message[];
}) {
  if (messages.length === 0) {
    return <Welcome />;
  }
  return (
    <ChatThread>
      {numbered(messages).map(({ key, message, name }) => (
        <ConversationMessage
          clock={isLive(message) ? clock : STILL}
          key={key}
          message={message}
          name={name}
        />
      ))}
    </ChatThread>
  );
}
