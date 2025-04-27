import { MultiSelect, Select } from "@inkjs/ui";
import { Box, render } from "ink";

render(
  <Box>
    <Select
      options={[
        {
          label: "Red",
          value: "red",
        },
        {
          label: "Green",
          value: "green",
        },
        {
          label: "Yellow",
          value: "yellow",
        },
        /* ... */
      ]}
      onChange={(newValue) => {
        // `newValue` equals the `value` field of the selected option
        // For example, "yellow"
        console.log(newValue);
      }}
    />
    <MultiSelect
      options={[
        {
          label: "Red",
          value: "red",
        },
        {
          label: "Green",
          value: "green",
        },
        {
          label: "Yellow",
          value: "yellow",
        },
        /* ... */
      ]}
      onChange={(newValue) => {
        // `newValue` is an array of `value` fields of the selected options
        // For example, ["green", "yellow"]
      }}
    />
  </Box>,
);
