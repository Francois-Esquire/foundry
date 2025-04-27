/* eslint-disable no-unused-vars */

import { generateId } from "ai";
import { create } from "zustand";

// Example usage (optional, for demonstration)
// const tasks = useAppStore((state) => state.tasks);
// const products = useAppStore((state) => state.products);
// const addTask = useAppStore((state) => state.addTask);
// const addProduct = useAppStore((state) => state.addProduct);

// Define basic types for tasks and subtasks
// We can expand these later based on the actual data structure from the task manager
export interface Subtask {
  id: string; // e.g., "1.1", "5.3"
  title: string;
  status:
    | "pending"
    | "in-progress"
    | "done"
    | "review"
    | "deferred"
    | "cancelled";
  productId?: string;
  // Add other relevant subtask properties here
}

// Define the TaskStatus type explicitly for clarity
export type TaskStatus =
  | "pending"
  | "in-progress"
  | "done"
  | "review"
  | "deferred"
  | "cancelled";

export interface Task {
  id: string; // e.g., "1", "15"
  title: string;
  description?: string;
  status: TaskStatus;
  priority?: "high" | "medium" | "low";
  dependencies?: string[]; // Array of task IDs it depends on
  subtasks?: Subtask[];
  productId?: string;
  // Add other relevant task properties here (details, testStrategy, complexityScore, etc.)
}

// Define Product interface
export interface Product {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  // Add other relevant product properties
}

// Define Configuration interface
export interface AppConfig {
  basePath: string;
  autoImportMCPs: boolean;
  // Add other config properties as needed
}

// Define the store's state shape
export interface AppState {
  tasks: Task[];
  products: Product[];
  config: AppConfig;
  // Add other state slices as needed, e.g., documents
}

// Define the store's actions
export interface AppActions {
  // --- Task Actions ---
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  updateTask: (taskId: string, updates: Partial<Task>) => void;
  setTaskStatus: (taskId: string, status: TaskStatus) => void; // Use TaskStatus type
  removeTask: (taskId: string) => void;
  addSubtask: (parentId: string, subtask: Subtask) => void;
  updateSubtask: (
    parentId: string,
    subtaskId: string,
    updates: Partial<Subtask>,
  ) => void;
  removeSubtask: (parentId: string, subtaskId: string) => void;
  addDependency: (taskId: string, dependencyId: string) => void;
  removeDependency: (taskId: string, dependencyId: string) => void;
  clearSubtasks: (taskId: string) => void;

  // --- Product Actions ---
  setProducts: (products: Product[]) => void;
  addProduct: (product: Product) => void;
  updateProduct: (productId: string, updates: Partial<Product>) => void;
  removeProduct: (productId: string) => void;

  // --- Config Actions ---
  setConfig: (config: Partial<AppConfig>) => void;
  setBasePath: (basePath: string) => void;
  setAutoImportMCPs: (autoImport: boolean) => void;
}

// Default configuration values
const defaultConfig: AppConfig = {
  basePath: process.cwd(), // Default to current working directory
  autoImportMCPs: true,
};

// Create the Zustand store
export const useAppStore = create<AppState & AppActions>((set) => ({
  // Initial state
  tasks: [],
  products: [],
  config: defaultConfig,

  // --- Task Action Implementations ---
  setTasks: (tasks) => set({ tasks }),
  addTask: (task) =>
    set((state) => ({
      tasks: [...state.tasks, { ...task, id: task.id || generateId() }],
    })),
  updateTask: (taskId, updates) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId ? { ...task, ...updates } : task,
      ),
    })),
  setTaskStatus: (taskId, status) =>
    set((state) => ({
      tasks: state.tasks.map((task) => {
        if (task.id === taskId) {
          // Ensure subtask status updates maintain the correct type
          const updatedSubtasks = task.subtasks?.map((sub) => ({
            ...sub,
            status: status === "done" ? ("done" as TaskStatus) : sub.status,
          }));
          return { ...task, status, subtasks: updatedSubtasks };
        }
        return task;
      }),
    })),
  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((task) => task.id !== taskId),
      // Consider also removing tasks that depend on the removed task? Or handle in calling code.
    })),
  addSubtask: (parentId, subtask) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === parentId
          ? {
              ...task,
              subtasks: [
                ...(task.subtasks || []),
                { ...subtask, id: subtask.id || generateId() },
              ],
            }
          : task,
      ),
    })),
  updateSubtask: (parentId, subtaskId, updates) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === parentId
          ? {
              ...task,
              subtasks: task.subtasks?.map((sub) =>
                sub.id === subtaskId ? { ...sub, ...updates } : sub,
              ),
            }
          : task,
      ),
    })),
  removeSubtask: (parentId, subtaskId) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === parentId
          ? {
              ...task,
              subtasks: task.subtasks?.filter((sub) => sub.id !== subtaskId),
            }
          : task,
      ),
    })),
  addDependency: (taskId, dependencyId) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              dependencies: [...(task.dependencies || []), dependencyId].filter(
                (v, i, a) => a.indexOf(v) === i,
              ), // Add unique
            }
          : task,
      ),
    })),
  removeDependency: (taskId, dependencyId) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              dependencies: task.dependencies?.filter(
                (dep) => dep !== dependencyId,
              ),
            }
          : task,
      ),
    })),
  clearSubtasks: (taskId) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId ? { ...task, subtasks: [] } : task,
      ),
    })),

  // --- Product Action Implementations ---
  setProducts: (products) => set({ products }),
  addProduct: (product) =>
    set((state) => ({
      products: [
        ...state.products,
        {
          ...product,
          id: product.id || generateId(),
          createdAt: product.createdAt || new Date(),
        }, // Ensure createdAt
      ],
    })),
  updateProduct: (productId, updates) =>
    set((state) => ({
      products: state.products.map((product) =>
        product.id === productId ? { ...product, ...updates } : product,
      ),
    })),
  removeProduct: (productId) =>
    set((state) => ({
      products: state.products.filter((product) => product.id !== productId),
    })),

  // --- Config Action Implementations ---
  setConfig: (configUpdate) =>
    set((state) => ({ config: { ...state.config, ...configUpdate } })),
  setBasePath: (basePath) =>
    set((state) => ({ config: { ...state.config, basePath } })),
  setAutoImportMCPs: (autoImportMCPs) =>
    set((state) => ({ config: { ...state.config, autoImportMCPs } })),
}));
