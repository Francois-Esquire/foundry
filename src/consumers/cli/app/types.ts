export interface Product {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in-progress" | "completed";
  createdAt: Date;
}
