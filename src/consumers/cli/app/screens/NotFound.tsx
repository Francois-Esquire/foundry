import React from "react";
import { Box, Text } from "ink";
import { useNavigate } from "react-router";

import { Button } from "../components/Button";
import { PageFooter } from "../components/PageFooter";
import { theme } from "../theme";

export function NotFoundScreen() {
  const navigate = useNavigate();

  const isButtonFocused = true;

  return (
    <Box
      width="100%"
      height="100%"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      padding={theme.spacing.sm}
    >
      <Box marginBottom={theme.spacing.sm}>
        <Text bold color={theme.colors.error}>
          404 - Page Not Found
        </Text>
      </Box>

      <Box marginBottom={theme.spacing.md}>
        <Text color={theme.colors.text}>
          The requested screen could not be found.
        </Text>
      </Box>

      <Button onPress={() => navigate("/")}>Go to Welcome Screen</Button>

      <PageFooter helpText="(Press Enter to continue)" />
    </Box>
  );
}
