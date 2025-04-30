import React from "react";
import { Box, Text } from "ink";

import CLI from "../components/cli";
import { Link } from "../components/Link";
import { WelcomeBanner } from "../components/welcome-banner";

export function WelcomeScreen() {
  return (
    <Box flexDirection="column" padding={1} position="relative">
      <Box flexDirection="column" padding={1} position="absolute">
        <Link to="/dashboard">Dashboard</Link>
      </Box>
      <WelcomeBanner />

      <Box borderStyle="round" paddingX={1} width={64}>
        <Text bold color="magenta">
          Foundry CLI
        </Text>

        <Text>
          Easily manage your products, user journeys, and system documentation.
        </Text>
      </Box>

      <Box flexDirection="column" padding={1}>
        {/* <Box marginY={1}></Box> */}

        <Box marginY={1}></Box>
      </Box>

      <CLI />
    </Box>
  );
}
