import { hud } from "@/model/palette";
import { fitSteps, type Step } from "@/model/steps";
import type { Thread } from "@/model/thread";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function look(step: Step, frame: number) {
  if (step.status === "success") {
    return { bg: hud.okDeep, fg: hud.ok, icon: "✓", link: hud.okDim };
  }
  if (step.status === "running") {
    return {
      bg: hud.amber,
      fg: hud.ink,
      icon: SPINNER[frame % SPINNER.length] ?? "⠋",
      link: hud.amber,
    };
  }
  if (step.status === "error") {
    return { bg: hud.tint, fg: hud.red, icon: "✗", link: hud.faint };
  }
  return {
    bg: hud.tint,
    fg: hud.dim,
    icon: step.added ? "✚" : "○",
    link: hud.faint,
  };
}

export function Steps({
  frame,
  thread,
  width,
}: {
  readonly frame: number;
  readonly thread: Thread;
  readonly width: number;
}) {
  if (thread.phase === "planning") {
    return (
      <text fg={hud.amber} wrapMode="none">
        {`${SPINNER[frame % SPINNER.length]} Planning the goal into to-dos`}
      </text>
    );
  }
  if (thread.todos.length === 0) {
    return (
      <text fg={hud.dim} truncate wrapMode="none">
        No to-dos yet. A goal is planned into two to four.
      </text>
    );
  }
  const { after, before, steps } = fitSteps(thread.todos, width);
  return (
    <text wrapMode="none">
      {before > 0 ? <span fg={hud.dim}>{`‹${before} `}</span> : null}
      {steps.map((step, index) => {
        const { bg, fg, icon, link } = look(step, frame);
        const label = step.label === "" ? "" : `${step.label} `;
        return (
          <span key={step.id}>
            <span bg={bg} fg={fg}>
              {step.status === "running" ? (
                <b>{` ${icon} ${step.number} ${label}`}</b>
              ) : (
                ` ${icon} ${step.number} ${label}`
              )}
            </span>
            {index < steps.length - 1 ? <span fg={link}>━━</span> : null}
          </span>
        );
      })}
      {after > 0 ? <span fg={hud.dim}>{` ${after}›`}</span> : null}
    </text>
  );
}
