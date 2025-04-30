import React from "react";
import { Box, Text, useFocus } from "ink";

import { theme } from "../../theme";

interface TerminalChatInputProps {
  input: string;
  cursor: number;
  isFocused: boolean;
}

export function TerminalChatInput({
  input,
  cursor,
  isFocused,
}: TerminalChatInputProps) {
  return (
    <Box
      width="100%"
      borderStyle="round"
      borderColor={isFocused ? theme.colors.borderFocused : undefined}
    >
      <Text>{isFocused ? "› " : "> "}</Text>
      <Text>{input.substring(0, cursor)}</Text>
      <Text backgroundColor={isFocused ? "cyan" : "gray"}>
        {isFocused ? " " : ""}
      </Text>
      <Text>{input.substring(cursor)}</Text>
    </Box>
  );
}
