import { useCallback, useEffect, useState } from "react";

export type EventHandler = (...args: any[]) => void;
export type EventMap = Map<string, Set<EventHandler>>;

const events = new Map<string, Set<EventHandler>>();
/**
 * A simple event emitter hook for Ink-based CLI applications
 */
export const useAppEvents = () => {
  // Add an event listener
  const on = useCallback(
    (eventName: string, handler: EventHandler) => {
      if (!events.has(eventName)) {
        events.set(eventName, new Set());
      }
      events.get(eventName)!.add(handler);

      // Return cleanup function
      return () => {
        const handlers = events.get(eventName);
        if (handlers) {
          handlers.delete(handler);
          if (handlers.size === 0) {
            events.delete(eventName);
          }
        }
      };
    },
    [events],
  );

  // Remove an event listener
  const off = useCallback(
    (eventName: string, handler: EventHandler) => {
      const handlers = events.get(eventName);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          events.delete(eventName);
        }
      }
    },
    [events],
  );

  // Add a one-time event listener
  const once = useCallback(
    (eventName: string, handler: EventHandler) => {
      const onceWrapper = (...args: any[]) => {
        handler(...args);
        off(eventName, onceWrapper);
      };

      return on(eventName, onceWrapper);
    },
    [on, off],
  );

  // Emit an event
  const emit = useCallback(
    (eventName: string, ...args: any[]) => {
      const handlers = events.get(eventName);
      if (handlers) {
        handlers.forEach((handler) => {
          try {
            handler(...args);
          } catch (error) {
            console.error(`Error in event handler for ${eventName}:`, error);
          }
        });
      }
      return handlers ? handlers.size > 0 : false;
    },
    [events],
  );

  // Remove all listeners for a specific event or all events
  const removeAllListeners = useCallback(
    (eventName?: string) => {
      if (eventName) {
        events.delete(eventName);
      } else {
        events.clear();
      }
    },
    [events],
  );

  // Get handler count for an event
  const listenerCount = useCallback(
    (eventName: string) => {
      const handlers = events.get(eventName);
      return handlers ? handlers.size : 0;
    },
    [events],
  );

  // Clean up all event handlers on unmount
  useEffect(() => {
    return () => {
      events.clear();
    };
  }, [events]);

  return {
    on,
    off,
    once,
    emit,
    removeAllListeners,
    listenerCount,
  };
};

export default useAppEvents;
