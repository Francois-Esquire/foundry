import React, { useEffect, useState } from "react";
import { useFocus, useInput, useStdout } from "ink";
import { useNavigate } from "react-router";

import { ChatLayout } from "../components/chat";
import { useStreamingChat } from "../hooks/useStreamingChat";

// Define focusable elements
type FocusElement = "input" | "scrollUp" | "scrollDown" | "backButton";

export function ChatScreen() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const { stdout } = useStdout();

  // Scroll and focus state
  const [scrollPosition, setScrollPosition] = useState(0);
  const [focusedElement, setFocusedElement] = useState<FocusElement>("input");
  const visibleHeight = 12; // Maximum visible messages in chat window

  // Use our streaming chat hook with debug mode disabled by default
  const { messages, streamingMessage, isLoading, sendMessage } =
    useStreamingChat({
      debug: true, // Set to false by default to use the OpenAI integration
      initialMessages: [
        {
          id: "welcome",
          content: "Welcome to Foundry Chat! How can I help you today?",
          isUser: false,
          timestamp: Date.now(),
        },
      ],
      onMessageComplete: () => {
        // Auto-scroll to bottom when message is complete
        scrollToBottom();
      },
    });

  // Automatically scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages.length]);

  // Calculate max scroll position
  const maxScroll = Math.max(0, messages.length - visibleHeight);

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = () => {
    setScrollPosition(Math.max(0, messages.length - visibleHeight));
  };

  // Handle scroll actions
  const scrollUp = () => {
    setScrollPosition(Math.max(0, scrollPosition - 1));
  };

  const scrollDown = () => {
    setScrollPosition(Math.min(maxScroll, scrollPosition + 1));
  };

  // Set up mouse wheel event handling
  useEffect(() => {
    // Enable mouse events in the terminal
    if (stdout.isTTY) {
      stdout.write("\x1b[?1000h"); // Enable mouse tracking
      stdout.write("\x1b[?1003h"); // Enable mouse movement tracking
      stdout.write("\x1b[?1006h"); // Enable SGR mouse mode

      // Handle mouse wheel/trackpad events
      const handleMouseEvent = (data: Buffer) => {
        const str = data.toString();

        // Check if it's a mouse wheel event (common encoding for wheel events)
        if (str.includes("[<") && str.includes("M")) {
          // Mouse wheel up
          if (str.includes("65;") || str.includes("64;")) {
            scrollUp();
          }
          // Mouse wheel down
          else if (str.includes("66;") || str.includes("67;")) {
            scrollDown();
          }
        }
      };

      // Add event listener for data
      process.stdin.on("data", handleMouseEvent);

      // Clean up on unmount
      return () => {
        stdout.write("\x1b[?1000l"); // Disable mouse tracking
        stdout.write("\x1b[?1003l"); // Disable mouse movement tracking
        stdout.write("\x1b[?1006l"); // Disable SGR mouse mode
        process.stdin.removeListener("data", handleMouseEvent);
      };
    }
  }, [scrollPosition, maxScroll, stdout]);

  // Focus navigation - simplified to avoid TypeScript errors
  const focusNext = () => {
    if (focusedElement === "backButton") setFocusedElement("scrollUp");
    else if (focusedElement === "scrollUp") setFocusedElement("input");
    else if (focusedElement === "input") setFocusedElement("scrollDown");
    else setFocusedElement("backButton");
  };

  const focusPrev = () => {
    if (focusedElement === "backButton") setFocusedElement("scrollDown");
    else if (focusedElement === "scrollUp") setFocusedElement("backButton");
    else if (focusedElement === "input") setFocusedElement("scrollUp");
    else setFocusedElement("input");
  };

  // Handle user input
  const handleSendMessage = async (content: string) => {
    if (!content.trim()) return;

    setInput("");
    setCursor(0);
    await sendMessage(content);
  };

  useInput((char, key) => {
    if (key.escape) {
      navigate("/dashboard");
      return;
    }

    // Tab navigation
    if (key.tab) {
      if (key.shift) {
        focusPrev();
      } else {
        focusNext();
      }
      return;
    }

    // Handle button actions on Enter
    if (key.return) {
      if (focusedElement === "backButton") {
        navigate("/dashboard");
        return;
      }
      if (focusedElement === "scrollUp") {
        scrollUp();
        return;
      }
      if (focusedElement === "scrollDown") {
        scrollDown();
        return;
      }
      if (focusedElement === "input" && input.trim()) {
        handleSendMessage(input);
        return;
      }
    }

    // Only process input when input field is focused
    if (focusedElement === "input") {
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setInput(input.substring(0, cursor - 1) + input.substring(cursor));
          setCursor(cursor - 1);
        }
        return;
      }

      if (key.leftArrow && cursor > 0) {
        setCursor(cursor - 1);
      }

      if (key.rightArrow && cursor < input.length) {
        setCursor(cursor + 1);
      }

      // Add character at cursor position
      if (!key.ctrl && !key.meta && char && char.length === 1) {
        setInput(input.substring(0, cursor) + char + input.substring(cursor));
        setCursor(cursor + 1);
      }
    }
  });

  return (
    <ChatLayout
      messages={messages}
      streamingMessage={streamingMessage}
      isLoading={isLoading}
      input={input}
      cursor={cursor}
      scrollPosition={scrollPosition}
      maxScroll={maxScroll}
      visibleHeight={visibleHeight}
      focusedElement={focusedElement}
      onBack={() => navigate("/dashboard")}
      onSendMessage={handleSendMessage}
      scrollUp={scrollUp}
      scrollDown={scrollDown}
    />
  );
}
