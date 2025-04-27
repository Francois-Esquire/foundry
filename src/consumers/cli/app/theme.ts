// import type { ForegroundColor } from 'ink'; // Removed import

// Basic Theme Definition

// Define color palette (using string types)
const colors = {
  primary: "cyan",
  secondary: "magenta",
  success: "green",
  warning: "yellow",
  error: "red",
  info: "blue",
  text: "white",
  textDim: "gray",
  border: "gray",
  borderFocused: "cyan",
  background: "black",
};

// Define spacing (consistent margins/paddings)
const spacing = {
  xs: 0,
  sm: 1,
  md: 2,
  lg: 3,
};

// Define border styles
const borders = {
  default: "round" as const,
  selected: "double" as const,
};

// Combine into a theme object
export const theme = {
  colors,
  spacing,
  borders,
};

// Example Usage (in components):
// import { theme } from './theme';
// ...
// <Text color={theme.colors.primary}>Hello</Text>
// <Box padding={theme.spacing.sm} borderStyle={theme.borders.default}>
