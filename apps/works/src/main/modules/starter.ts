import { buildModuleSdkPack } from "@foundry/modules/sdk/index";
import { composeModuleTemplate } from "@foundry/modules/template/compose";

export async function moduleStarter(
  id: string,
  name: string
): Promise<Readonly<Record<string, string>>> {
  const template = await composeModuleTemplate({
    base: {
      files: {
        "index.html":
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Module</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
        "package.json": JSON.stringify(
          {
            dependencies: { react: "19.3.0", "react-dom": "19.3.0" },
            devDependencies: {
              "@tailwindcss/vite": "4.3.3",
              "@vitejs/plugin-react": "5.2.0",
              tailwindcss: "4.3.3",
              vite: "8.2.2",
            },
            name: "module-app",
            private: true,
            scripts: { build: "vite build" },
            type: "module",
          },
          null,
          2
        ),
        "src/App.tsx": `import { useState } from "react";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <main>\n      <h1>{${JSON.stringify(name)}}</h1>\n      <p>Edit this app, save your changes, and build a release.</p>\n      <button onClick={() => setCount((value) => value + 1)} type="button">Count: {count}</button>\n    </main>\n  );\n}\n`,
        "src/index.css":
          '@import "tailwindcss";\n\nbody { margin: 0; font-family: system-ui, sans-serif; color: #171717; background: #fff; }\nmain { max-width: 44rem; margin: 4rem auto; padding: 0 2rem; }\nh1 { font-size: 2rem; font-weight: 600; letter-spacing: -0.03em; }\np { color: #666; line-height: 1.6; }\nbutton { border: 1px solid #ccc; border-radius: 0.5rem; padding: 0.6rem 1rem; background: #fafafa; font: inherit; cursor: pointer; }\n',
        "src/main.tsx":
          'import { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\nconst root = document.getElementById("root");\nif (!root) { throw new Error("Application root missing"); }\ncreateRoot(root).render(<App />);\n',
      },
      id: "react-starter",
      name: "React starter",
    },
    project: {
      displayName: name,
      id: `module-${id}`,
      packageName: `module-${id}`,
    },
    sdk: await buildModuleSdkPack(),
  });
  return template.files;
}
