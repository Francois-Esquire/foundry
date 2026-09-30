import { createRoot } from "react-dom/client";
import { App } from "./ui/app";
import "./ui/atlas.css";

const element = document.getElementById("root");
if (!element) {
  throw new Error("Atlas mount element is missing.");
}
createRoot(element).render(<App />);
