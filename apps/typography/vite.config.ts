import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const FIXTURES = path.join(import.meta.dirname, "test/fixtures");

/**
 * Openly licensed fonts a first-time user can load without having a font to
 * hand. They are the test fixtures, served with their licence texts.
 */
const SAMPLE_FONTS = [
  { file: "Lato-Regular.ttf", licence: "Lato-OFL.txt" },
  { file: "SofiaSans-wght.ttf", licence: "SofiaSans-OFL.txt" },
  {
    file: "NotoSansDevanagari-wdth-wght.ttf",
    licence: "NotoSansDevanagari-OFL.txt",
  },
  { file: "NotoNaskhArabic-wght.ttf", licence: "NotoNaskhArabic-OFL.txt" },
  { file: "DavidLibre-Regular.ttf", licence: "DavidLibre-OFL.txt" },
];

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** A fixture directory the app can read: its route, its files and its index. */
interface Mount {
  readonly directory: string;
  files(): Promise<string[]>;
  index(files: readonly string[]): Promise<string>;
  readonly route: string;
}

const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) =>
      path.relative(directory, path.join(entry.parentPath, entry.name))
    )
    .sort();
};

const MOUNTS: Mount[] = [
  {
    directory: path.join(FIXTURES, "fonts"),
    files: async () =>
      SAMPLE_FONTS.flatMap(({ file, licence }) => [file, licence]),
    index: async () => JSON.stringify(SAMPLE_FONTS),
    route: "samples",
  },
  {
    directory: path.join(FIXTURES, "generation"),
    files() {
      return filesUnder(this.directory);
    },
    // One entry per recorded run: the directories that hold a `run.json`.
    index: async (files) =>
      JSON.stringify(
        files
          .filter((file) => path.basename(file) === "run.json")
          .map((file) => path.dirname(file))
      ),
    route: "recorded-runs",
  },
  {
    directory: path.join(FIXTURES, "evidence"),
    files() {
      return filesUnder(this.directory);
    },
    async index() {
      return await readFile(path.join(this.directory, "index.json"), "utf8");
    },
    route: "evidence",
  },
];

/**
 * Serves test fixtures the app can open as samples: fonts, recorded generation
 * runs and evidence photographs. They are served in development and copied
 * into a build, so the app never depends on a remote host for them.
 */
const fixtureMounts = (): Plugin => ({
  configureServer(server) {
    for (const mount of MOUNTS) {
      server.middlewares.use(
        `/${mount.route}`,
        async (request, response, next) => {
          const name = decodeURIComponent(
            (request.url ?? "").split("?")[0]?.slice(1) ?? ""
          );
          const files = await mount.files();
          if (name === "index.json") {
            response.setHeader("Content-Type", "application/json");
            response.end(await mount.index(files));
            return;
          }
          if (!files.includes(name)) {
            next();
            return;
          }
          response.setHeader(
            "Content-Type",
            CONTENT_TYPES[path.extname(name)] ?? "application/octet-stream"
          );
          response.end(await readFile(path.join(mount.directory, name)));
        }
      );
    }
  },
  async generateBundle() {
    for (const mount of MOUNTS) {
      const files = await mount.files();
      this.emitFile({
        fileName: `${mount.route}/index.json`,
        source: await mount.index(files),
        type: "asset",
      });
      for (const name of files.filter((file) => file !== "index.json")) {
        this.emitFile({
          fileName: `${mount.route}/${name}`,
          source: await readFile(path.join(mount.directory, name)),
          type: "asset",
        });
      }
    }
  },
  name: "typography:fixture-mounts",
});

export default defineConfig({
  build: { target: "es2022" },
  // Both engines locate their WebAssembly next to their own module, which
  // dependency pre-bundling would break.
  optimizeDeps: { exclude: ["harfbuzzjs", "pyodide"] },
  plugins: [react(), fixtureMounts()],
  resolve: { alias: { "~": path.join(import.meta.dirname, "src") } },
  worker: { format: "es" },
});
