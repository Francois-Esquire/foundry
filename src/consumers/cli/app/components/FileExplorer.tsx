import React, { useEffect, useState } from "react";
import { execa } from "execa";
import { Box, Text, useInput } from "ink";

export function FileExplorer() {
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [pointer, setPointer] = useState(0);

  useEffect(() => {
    setLoading(true);
    execa("ls", ["-p"]).then((result) => {
      setFiles([...result.stdout.split("\n")]);
    });
    execa("pwd").then((result) => {
      setPath(result.stdout);
    });
    setLoading(false);
  }, []);

  useInput((_, key) => {
    if (key.upArrow) {
      setPointer((prev) => (prev <= 0 ? 0 : prev - 1));
    }

    if (key.downArrow) {
      setPointer((prev) =>
        prev >= files.length - 1 ? files.length - 1 : prev + 1,
      );
    }

    if (key.return) {
      if (!files[pointer]?.includes("/")) return;

      let newPath = `${path}/${files[pointer]}`.slice(0, -1);
      execa("ls", ["-p", newPath]).then((result) => {
        setFiles([...result.stdout.split("\n")]);
      });
      setPath(newPath);
      setPointer(0);
    }

    if (key.delete || key.backspace) {
      let newPath = path.split("/").slice(0, -1).join("/");
      if (newPath[newPath.length - 1] === "/") {
        newPath = newPath.slice(0, -1);
      }

      execa("ls", ["-p", newPath]).then((result) => {
        setFiles([...result.stdout.split("\n")]);
      });
      setPath(newPath);
      setPointer(0);
    }
  });

  return (
    <Box>
      <Text color="yellow">
        Path: <Text color="cyan">{path}</Text>
      </Text>
      <Box>
        {loading ? (
          <Text color="grey">Loading...</Text>
        ) : (
          files.map((file, index) => {
            const selected = index === pointer;

            return (
              <Box
                key={index}
                flexDirection="row"
                paddingLeft={1}
                justifyContent="flex-start"
              >
                <Text color="greenBright">{selected ? "> " : "  "}</Text>
                <Text color={selected ? "greenBright" : "grey"}>{file}</Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box flexDirection="column">
        <Text color="grey">
          Press <Text color="greenBright">Enter</Text> to enter a directory,{" "}
          <Text color="greenBright">Delete</Text> to go up a directory
        </Text>
        <Text color="grey">
          Use <Text color="yellow">Up</Text> and{" "}
          <Text color="yellow">Down</Text> to navigate
        </Text>
      </Box>
    </Box>
  );
}
