import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme";
import { Button } from "./Button";

export interface PageFooterProps {
  helpText?: string;
  children?: React.ReactNode;
  isFocused?: boolean;
  onBack?: () => void;
}

export const PageFooter: React.FC<PageFooterProps> = ({
  helpText = "(Tab to navigate, ←/→ to move, Enter to select, Esc to go back)",
  children,
  isFocused = false,
  onBack,
}) => {
  return (
    <Box
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      marginTop={theme.spacing.md}
      paddingY={theme.spacing.xs}
      borderStyle="single"
      borderColor={theme.colors.border}
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      {onBack && (
        <Box justifyContent="center" marginBottom={1}>
          <Button onPress={onBack} isFocused={isFocused}>
            Back to Dashboard
          </Button>
        </Box>
      )}
      {children}
      <Text dimColor>{helpText}</Text>
    </Box>
  );
};
