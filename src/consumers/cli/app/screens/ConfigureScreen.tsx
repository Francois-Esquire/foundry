import React from "react";
// Use components from @inkjs/ui
import { Select, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";

import { useAppStore } from "../store";

export function ConfigureScreen() {
  const config = useAppStore((state) => state.config);
  const setBasePath = useAppStore((state) => state.setBasePath);
  const setAutoImportMCPs = useAppStore((state) => state.setAutoImportMCPs);

  // For uncontrolled TextInput, we don't need useState for its value,
  // but we might want it if we need to read the current value elsewhere.
  // For now, let's assume we only care about the submitted value.
  // const [basePathInput, setBasePathInput] = useState(config.basePath);

  const handleBasePathSubmit = (value: string) => {
    setBasePath(value);
    // TODO: Implement focus management
  };

  // Options for the Select component (values must be strings)
  const autoImportItems = [
    { label: "Yes", value: "true" },
    { label: "No", value: "false" },
  ];

  // onChange handler for Select receives the string value
  const handleAutoImportChange = (value: string) => {
    // Parse string back to boolean
    const boolValue = value === "true";
    setAutoImportMCPs(boolValue);
  };

  // Note: @inkjs/ui Select doesn't seem to have an initialValue/initialIndex prop.
  // It will likely default to the first option.

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Configuration</Text>
      <Box marginTop={1}>
        <Box width="25%">
          <Text>Base Path:</Text>
        </Box>
        <Box flexGrow={1}>
          {/* Use uncontrolled TextInput from @inkjs/ui */}
          <TextInput
            // Remove value prop
            // onChange={setBasePathInput} // onChange gives the current value if needed
            defaultValue={config.basePath} // Set initial value
            onSubmit={handleBasePathSubmit}
            placeholder="Enter project base path..."
          />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Box width="25%">
          <Text>Auto Import MCPs:</Text>
        </Box>
        <Box flexGrow={1}>
          <Select
            options={autoImportItems}
            // initialIndex={initialIndex >= 0 ? initialIndex : 0} // Removed initialIndex
            onChange={handleAutoImportChange}
          />
        </Box>
      </Box>
      {/* Add navigation instructions or back button as needed */}
      <Box marginTop={1}>
        <Text dimColor>
          Use Enter/Tab to navigate fields. Use arrow keys for selection.
        </Text>
      </Box>
    </Box>
  );
}
