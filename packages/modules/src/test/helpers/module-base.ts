import type { ModuleBase } from "../../template/compose";

/**
 * A React + Vite application on the Bun runtime with Tailwind styling: the
 * shape a Module workspace's `packages/app` starts from. The composer replaces
 * `vite.config.ts` and keeps the rest, so the integration test can install,
 * build, and serve it.
 */
export const reactModuleBase: ModuleBase = {
  files: {
    "index.html":
      '<!DOCTYPE html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    "package.json": JSON.stringify(
      {
        dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
        devDependencies: {
          "@tailwindcss/vite": "^4",
          "@vitejs/plugin-react": "^4.3.4",
          tailwindcss: "^4",
          vite: "^5.4.10",
        },
        name: "bun-react-app",
        scripts: {
          build: "bunx vite build",
          dev: "bunx vite --host 0.0.0.0 --port 5173",
        },
        type: "module",
      },
      null,
      2
    ),
    "src/App.tsx": `import { useState } from "react"
export default function App() {
  const [count, setCount] = useState(0)
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-white">
      <div className="text-center space-y-4">
        <h1 className="text-3xl font-bold">Bun + React</h1>
        <button onClick={() => setCount(c => c + 1)} className="px-4 py-2 bg-amber-500 text-black rounded-lg">
          Count: {count}
        </button>
      </div>
    </div>
  )
}`,
    "src/index.css": '@import "tailwindcss";',
    "src/main.tsx": `import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./index.css"
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>)`,
    "vite.config.ts": `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
export default defineConfig({ plugins: [react(), tailwindcss()] })`,
  },
  id: "bun-react",
  instructions:
    "React 18 + Vite running on the Bun runtime. Edit `src/App.tsx`; the entry is `src/main.tsx`. " +
    'Styling is Tailwind v4: utility classes in JSX, CSS entry `src/index.css` (`@import "tailwindcss"`).',
  name: "Bun + React",
};
