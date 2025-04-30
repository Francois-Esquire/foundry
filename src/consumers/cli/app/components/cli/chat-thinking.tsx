import { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { useInterval } from "use-interval";

import { theme } from "../../theme";

const { log } = console;

export function TerminalChatInputThinking({
  onInterrupt,
  active,
  thinkingSeconds,
  isFocused,
}: {
  onInterrupt: () => void;
  active: boolean;
  thinkingSeconds: number;
  isFocused: boolean;
}) {
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [dots, setDots] = useState("");

  // Animate ellipsis
  useInterval(() => {
    setDots((prev) => (prev.length < 3 ? prev + "." : ""));
  }, 500);

  // Spinner frames with embedded seconds
  const ballFrames = [
    "( ●    )",
    "(  ●   )",
    "(   ●  )",
    "(    ● )",
    "(     ●)",
    "(    ● )",
    "(   ●  )",
    "(  ●   )",
    "( ●    )",
    "(●     )",
  ];
  const [frame, setFrame] = useState(0);

  useInterval(() => {
    setFrame((idx) => (idx + 1) % ballFrames.length);
  }, 80);

  // Keep the elapsed‑seconds text fixed while the ball animation moves.
  const frameTemplate = ballFrames[frame] ?? ballFrames[0];
  const frameWithSeconds = `${frameTemplate} ${thinkingSeconds}s`;

  // ---------------------------------------------------------------------
  // Raw stdin listener to catch the case where the terminal delivers two
  // consecutive ESC bytes ("\x1B\x1B") in a *single* chunk. Ink's `useInput`
  // collapses that sequence into one key event, so the regular two‑step
  // handler above never sees the second press.  By inspecting the raw data
  // we can identify this special case and trigger the interrupt while still
  // requiring a double press for the normal single‑byte ESC events.
  // ---------------------------------------------------------------------

  const { stdin, setRawMode } = useStdin();

  useEffect(() => {
    if (!active) {
      return;
    }

    // Ensure raw mode – already enabled by Ink when the component has focus,
    // but called defensively in case that assumption ever changes.
    setRawMode?.(true);

    const onData = (data: Buffer | string) => {
      if (awaitingConfirm) {
        return; // already awaiting a second explicit press
      }

      // Handle both Buffer and string forms.
      const str = Buffer.isBuffer(data) ? data.toString("utf8") : data;
      if (str === "\x1b\x1b") {
        // Treat as the first Escape press – prompt the user for confirmation.
        log(
          "raw stdin: received collapsed ESC ESC – starting confirmation timer",
        );
        setAwaitingConfirm(true);
        setTimeout(() => setAwaitingConfirm(false), 1500);
      }
    };

    stdin?.on("data", onData);

    return () => {
      stdin?.off("data", onData);
    };
  }, [stdin, awaitingConfirm, onInterrupt, active, setRawMode]);

  // No local timer: the parent component supplies the elapsed time via props.

  // Listen for the escape key to allow the user to interrupt the current
  // operation. We require two presses within a short window (1.5s) to avoid
  // accidental cancellations.
  useInput(
    (_input, key) => {
      if (!key.escape) {
        return;
      }

      if (awaitingConfirm) {
        log("useInput: second ESC detected – triggering onInterrupt()");
        onInterrupt();
        setAwaitingConfirm(false);
      } else {
        log("useInput: first ESC detected – waiting for confirmation");
        setAwaitingConfirm(true);
        setTimeout(() => setAwaitingConfirm(false), 1500);
      }
    },
    { isActive: active },
  );

  return (
    <Box
      width="100%"
      borderStyle="round"
      borderColor={isFocused ? theme.colors.borderFocused : undefined}
    >
      <Box
        flexDirection="row"
        width="100%"
        justifyContent="space-between"
        paddingRight={1}
      >
        <Box gap={2}>
          <Text>{frameWithSeconds}</Text>
          <Text>
            Thinking
            {dots}
          </Text>
        </Box>
        <Text>
          <Text dimColor>press</Text> <Text bold>Esc</Text>{" "}
          {awaitingConfirm ? (
            <Text bold>again</Text>
          ) : (
            <Text dimColor>twice</Text>
          )}{" "}
          <Text dimColor>to interrupt</Text>
        </Text>
      </Box>
    </Box>
  );
}
