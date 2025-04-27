import React from "react";
import { Box, Text } from "ink";

import { Button } from "../Button";

interface ScrollButtonsProps {
  scrollUp: () => void;
  scrollDown: () => void;
  isUpButtonFocused: boolean;
  isDownButtonFocused: boolean;
  scrollPosition: number;
  maxScroll: number;
}

export function ScrollButtons({
  scrollUp,
  scrollDown,
  isUpButtonFocused,
  isDownButtonFocused,
  scrollPosition,
  maxScroll,
}: ScrollButtonsProps) {
  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={1}
    >
      <Button onPress={scrollUp} isFocused={isUpButtonFocused}>
        ▲
      </Button>

      <Text>
        {scrollPosition > 0 || maxScroll > 0
          ? `${scrollPosition}/${maxScroll}`
          : ""}
      </Text>

      <Button onPress={scrollDown} isFocused={isDownButtonFocused}>
        ▼
      </Button>
    </Box>
  );
}
