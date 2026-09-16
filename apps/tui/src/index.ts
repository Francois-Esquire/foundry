import {
  ASCIIFont,
  Box,
  createCliRenderer,
  Text,
  TextAttributes,
} from "@opentui/core";

const renderer = await createCliRenderer({ exitOnCtrlC: true });

renderer.root.add(
  Box(
    { alignItems: "center", flexGrow: 1, justifyContent: "center" },
    Box(
      { alignItems: "flex-end", justifyContent: "center" },
      ASCIIFont({ font: "tiny", text: "OpenTUI" }),
      Text({ attributes: TextAttributes.DIM, content: "What will you build?" })
    )
  )
);
