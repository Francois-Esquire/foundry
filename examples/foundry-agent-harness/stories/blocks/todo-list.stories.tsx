import { defineStories, story } from "textbook-sh";
import { TodoList } from "@/components/blocks/todo-list";
import { clock, threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 10, width: 44 };

export default defineStories({
  component: "TodoList",
  description: "The thread's to-dos, each with the state of its work.",
  title: "Blocks/TodoList",
});

export const Empty = story({
  description: "A thread with no goal yet.",
  name: "Empty",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TodoList frame={clock.frame} thread={threads.idle} />,
      size
    ),
});

export const Planning = story({
  description: "The planner is turning a goal into to-dos.",
  name: "Planning",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TodoList frame={clock.frame} thread={threads.planning} />,
      size
    ),
});

export const Working = story({
  description: "One done, one running, one waiting, and one the worker added.",
  name: "Working",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TodoList frame={clock.frame} thread={threads.working} />,
      size
    ),
});

export const Done = story({
  description: "Every to-do finished.",
  name: "Done",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TodoList frame={clock.frame} thread={threads.done} />,
      size
    ),
});

export const Failed = story({
  description: "A turn failed, so the rest were cancelled.",
  name: "Failed",
  render: (renderer) =>
    renderFrame(
      renderer,
      <TodoList frame={clock.frame} thread={threads.failed} />,
      size
    ),
});
