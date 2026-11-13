import { createRoot } from "react-dom/client";
import { ScanApp } from "./scan-app";
import "../ui/spyglass.css";
import "./scan.css";

const element = document.getElementById("root");
if (!element) {
  throw new Error("Spyglass mount element is missing.");
}
createRoot(element).render(<ScanApp />);
