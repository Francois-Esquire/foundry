import React from "react";
import { Text, useFocus, useInput } from "ink";
import { useNavigate } from "react-router";

interface LinkProps {
  children: React.ReactNode;
  to: string;
}

export function Link({ children, to, ...props }: LinkProps) {
  const navigate = useNavigate();

  const { isFocused } = useFocus({
    id: `link-${to}`,
    autoFocus: false,
  });

  useInput((input, key) => {
    if (key.return && isFocused) {
      navigate(to);
    }
  });

  return (
    <Text {...props} color={isFocused ? "green" : "white"}>
      {children}
    </Text>
  );
}
