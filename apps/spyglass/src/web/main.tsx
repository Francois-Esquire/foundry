import { createRoot } from "react-dom/client";
import { App } from "./ui/app";
import "./ui/spyglass.css";

const element = document.getElementById("root");
if (!element) {
  throw new Error("Spyglass mount element is missing.");
}
createRoot(element).render(<App />);
