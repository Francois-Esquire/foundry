import "./notice.css";
import type { ReactNode } from "react";
import { Button } from "./button";

interface NoticeProps {
  /** A control that offers the way out, such as a retry button. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly id?: string;
  readonly onDismiss?: () => void;
  /** A problem interrupts assistive technology. A note waits its turn. */
  readonly tone?: "note" | "problem";
}

/**
 * A line of status that does not block the work. A problem says what went
 * wrong and what to do about it.
 */
export function Notice({
  action,
  children,
  id,
  onDismiss,
  tone = "note",
}: NoticeProps) {
  const body = (
    <>
      <span className="ty-label ty-notice-tag">
        {tone === "problem" ? "Problem" : "Note"}
      </span>
      <span className="ty-notice-text">{children}</span>
      {action}
      {onDismiss ? (
        <Button onClick={onDismiss} symbol="close">
          Dismiss
        </Button>
      ) : null}
    </>
  );
  return tone === "problem" ? (
    <div className="ty-notice" data-tone="problem" id={id} role="alert">
      {body}
    </div>
  ) : (
    <output className="ty-notice" data-tone="note" id={id}>
      {body}
    </output>
  );
}
