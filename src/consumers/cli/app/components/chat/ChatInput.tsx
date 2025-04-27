import React from "react";
import { Box, Text } from "ink";

import { theme } from "../../theme";

interface ChatInputProps {
  input: string;
  cursor: number;
  isFocused: boolean;
  onSubmit: (text: string) => void;
}

export function ChatInput({
  input,
  cursor,
  isFocused,
  onSubmit,
}: ChatInputProps) {
  return (
    <Box
      borderStyle="round"
      padding={1}
      borderColor={isFocused ? theme.colors.borderFocused : undefined}
    >
      <Text>{isFocused ? "› " : "> "}</Text>
      <Text>{input.substring(0, cursor)}</Text>
      <Text backgroundColor={isFocused ? "cyan" : "gray"}> </Text>
      <Text>{input.substring(cursor)}</Text>
    </Box>
  );
}
