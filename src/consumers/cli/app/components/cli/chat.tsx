import type React from "react";

import { useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import { useNavigate } from "react-router";

import { Button } from "../Button";
import { TerminalChatCommands } from "./chat-commands";
import { TerminalChatInput } from "./chat-input";
import { ChatMetrics } from "./chat-metrics";
import { TerminalChatInputThinking } from "./chat-thinking";

export function TerminalChat({
  isLoading,
  onSendMessage,
}: {
  isLoading: boolean;
  onSendMessage: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);

  const { isFocused, focus } = useFocus({
    id: "chat-input",
    autoFocus: true,
  });

  useInput((char: string, key) => {
    if (isFocused) {
      if (key.return) {
        console.log("input", input);
        setInput("");
        setCursor(0);
        onSendMessage(input);
      } else if (key.backspace || key.delete) {
        if (cursor > 0) {
          setInput(input.substring(0, cursor - 1) + input.substring(cursor));
          setCursor(cursor - 1);
        }
      } else {
        if (char.startsWith("/")) {
          focus("chat-commands");
        }

        if (key.leftArrow && cursor > 0) {
          setCursor(cursor - 1);
        }

        if (key.rightArrow && cursor < input.length) {
          setCursor(cursor + 1);
        }

        // Add character at cursor position
        if (!key.ctrl && !key.meta && char && char.length === 1) {
          setInput(input.substring(0, cursor) + char + input.substring(cursor));
          setCursor(cursor + 1);
        }

        setInput(input + char);
        setCursor(input.length + 1);
      }
    }
  });

  return (
    <Box flexDirection="column">
      {input.startsWith("/") && (
        <TerminalChatCommands input={input} selectedSlashSuggestion={0} />
      )}

      <Box flexDirection="row">
        <ChatMetrics tokens={0} cost={0} time={0} context={0} />
        <Box flexGrow={1} />
        <Box>
          <Button
            onPress={() => {
              navigate("/dashboard");
            }}
            variant="ghost"
          >
            Dashboard
          </Button>
          <Text> | </Text>
          <Button onPress={() => {}} variant="ghost">
            Reset
          </Button>
        </Box>
      </Box>
      <Box flexDirection="column">
        {isLoading ? (
          <TerminalChatInputThinking
            isFocused={isFocused}
            onInterrupt={() => {
              focus("chat-input");
            }}
            active={isLoading}
            thinkingSeconds={0}
          />
        ) : (
          <TerminalChatInput
            input={input}
            cursor={cursor}
            isFocused={isFocused}
          />
        )}
      </Box>
    </Box>
  );
}
