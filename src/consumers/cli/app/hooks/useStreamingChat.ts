/* eslint-disable no-unused-vars */
import { useCallback, useRef, useState } from "react";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

// Define chat message type
export interface ChatMessage {
  id: string;
  content: string;
  isUser: boolean;
  timestamp?: number;
}

interface UseStreamingChatOptions {
  initialMessages?: ChatMessage[];
  onError?: (error: Error) => void;
  onMessageComplete?: (message: ChatMessage) => void;
  debug?: boolean;
}

// Mock responses for debug mode
const debugResponses = [
  "I'm processing your request",
  "Let me think about that",
  "Processing your question",
  "I'm here to help with product management",
  "I can assist with your tasks and documentation",
];

export function useStreamingChat({
  initialMessages = [],
  onError,
  onMessageComplete,
  debug = false, // Debug mode is false by default
}: UseStreamingChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState("");

  // Use a ref to track the latest messages array without triggering useEffect
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  // Add a user message
  const addUserMessage = useCallback((content: string) => {
    if (!content.trim()) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      content,
      isUser: true,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    return userMessage;
  }, []);

  // Add an AI message
  const addAIMessage = useCallback((content: string) => {
    const aiMessage: ChatMessage = {
      id: `ai-${Date.now()}`,
      content,
      isUser: false,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, aiMessage]);
    return aiMessage;
  }, []);

  // Debug mode mock response function
  const generateDebugResponse = useCallback(async () => {
    // Mock AI response with delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Start streaming response
    let fullResponse = "";
    const randomResponse =
      debugResponses[Math.floor(Math.random() * debugResponses.length)] ||
      "I'm thinking...";

    // Simulate streaming by revealing one character at a time
    for (let i = 0; i < randomResponse.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      fullResponse += randomResponse[i];
      setStreamingMessage(fullResponse);
    }

    return fullResponse;
  }, []);

  // Generate AI response using Vercel AI SDK
  const generateAIResponse = useCallback(
    async (userPrompt: string) => {
      try {
        if (!process.env.OPENAI_API_KEY) {
          console.warn("OPENAI_API_KEY not found. Using fallback response.");
          return "I'm unable to connect to my AI services at the moment. Please make sure the OPENAI_API_KEY environment variable is set.";
        }

        // Simulate streaming with intermediate states
        setStreamingMessage("Thinking...");
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Prepare the conversation history
        const prompt =
          messagesRef.current
            .map(
              (msg) => `${msg.isUser ? "User" : "Assistant"}: ${msg.content}`,
            )
            .join("\n\n") + `\n\nUser: ${userPrompt}\n\nAssistant:`;

        // Generate response from OpenAI
        const { text } = await generateText({
          model: openai("gpt-3.5-turbo"),
          prompt,
          temperature: 0.7,
        });

        // Return the generated text
        return text;
      } catch (error) {
        console.error("Error generating AI response:", error);
        if (onError && error instanceof Error) {
          onError(error);
        }
        return "Sorry, I encountered an error while processing your request.";
      }
    },
    [messagesRef, onError],
  );

  // Send a message and get a response
  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      try {
        // Add user message
        addUserMessage(content);

        // Set loading state
        setIsLoading(true);
        setStreamingMessage("");

        // Generate response based on debug mode
        const response = debug
          ? await generateDebugResponse()
          : await generateAIResponse(content);

        // Add completed message
        const aiMessage = addAIMessage(response);

        // Clear streaming message and loading state
        setStreamingMessage("");
        setIsLoading(false);

        // Trigger callback if provided
        if (onMessageComplete) {
          onMessageComplete(aiMessage);
        }

        return aiMessage;
      } catch (error) {
        setIsLoading(false);
        console.error("Error in chat:", error);
        if (onError && error instanceof Error) {
          onError(error);
        }
      }
    },
    [
      addUserMessage,
      addAIMessage,
      onMessageComplete,
      onError,
      debug,
      generateDebugResponse,
      generateAIResponse,
    ],
  );

  // Clear all messages
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    streamingMessage,
    isLoading,
    sendMessage,
    addUserMessage,
    addAIMessage,
    clearMessages,
  };
}
