import { memo } from "react";
import { Reply } from "@/components/blocks/reply";
import { ToolRow } from "@/components/blocks/tool-row";
import { Welcome } from "@/components/blocks/welcome";
import { ChatMessage } from "@/components/ui/chat-message";
import { ChatThread } from "@/components/ui/chat-thread";
import type { Clock } from "@/model/screen";
import type { Encounter, Step } from "@/model/thread";

const STILL: Clock = { frame: 0, now: 0 };

function isLive(step: Step): boolean {
  return step.streaming || step.tools.some((tool) => tool.status === "running");
}

function StepBody({
  clock,
  step,
}: {
  readonly clock: Clock;
  readonly step: Step;
}) {
  if (step.text === "" && step.tools.length === 0) {
    return null;
  }
  return (
    <box flexDirection="column">
      {step.tools.map((tool) => (
        <ToolRow clock={clock} key={tool.id} tool={tool} />
      ))}
      <Reply
        key={step.streaming ? "streaming" : "finished"}
        markdown={step.text}
        streaming={step.streaming}
      />
    </box>
  );
}

function StepEntry({
  clock,
  name,
  step,
}: {
  readonly clock: Clock;
  readonly name: string;
  readonly step: Step;
}) {
  return (
    <ChatMessage name={name} sender="assistant" streaming={step.streaming}>
      <StepBody clock={clock} step={step} />
    </ChatMessage>
  );
}

function SaidEntry({
  name,
  sender,
  text,
}: {
  readonly name: string;
  readonly sender: "error" | "user";
  readonly text: string;
}) {
  return (
    <ChatMessage name={name} sender={sender}>
      <Reply markdown={text} streaming={false} />
    </ChatMessage>
  );
}

const ConversationStep = memo(StepEntry);
const Said = memo(SaidEntry);

function numbered(encounters: readonly Encounter[]) {
  let count = 0;
  return encounters.map((encounter) => ({
    encounter,
    steps: encounter.steps.map((step) => {
      count += 1;
      return { name: `Task ${count} · ${step.title}`, step };
    }),
  }));
}

export function Conversation({
  clock,
  encounters,
}: {
  readonly clock: Clock;
  readonly encounters: readonly Encounter[];
}) {
  if (encounters.length === 0) {
    return <Welcome />;
  }
  return (
    <ChatThread>
      {numbered(encounters).flatMap(({ encounter, steps }) => [
        <Said
          key={`${encounter.id}-goal`}
          name="You"
          sender="user"
          text={encounter.goal}
        />,
        ...steps.map(({ name, step }, index) => (
          <ConversationStep
            clock={isLive(step) ? clock : STILL}
            key={`${encounter.id}-step-${index}`}
            name={name}
            step={step}
          />
        )),
        ...(encounter.error === undefined
          ? []
          : [
              <Said
                key={`${encounter.id}-error`}
                name="The harness stopped"
                sender="error"
                text={encounter.error}
              />,
            ]),
      ])}
    </ChatThread>
  );
}
