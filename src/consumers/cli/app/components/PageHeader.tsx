import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme";
import { Button } from "./Button";

interface PageHeaderProps {
  title: string;
  showBackButton?: boolean;
  backButtonLabel?: string;
  onBack?: () => void;
  isBackButtonFocused?: boolean;
}

export function PageHeader({
  title,
  showBackButton = false,
  backButtonLabel = "Back",
  onBack,
  isBackButtonFocused = false,
}: PageHeaderProps) {
  return (
    <Box
      borderStyle="single"
      borderColor={theme.colors.primary}
      padding={1}
      marginBottom={1}
    >
      <Box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        width="100%"
      >
        <Text bold color={theme.colors.primary}>
          {title}
        </Text>

        {showBackButton && onBack && (
          <Button onPress={onBack} isFocused={isBackButtonFocused}>
            {backButtonLabel}
          </Button>
        )}
      </Box>
    </Box>
  );
}
