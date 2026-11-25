import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { MODULE_SDK_ENTRYPOINT } from "./entrypoint-source";

export interface ModuleSdkEmit {
  readonly declarations: string;
  readonly esm: string;
  readonly generatorDeclarations: string;
  readonly generatorEsm: string;
}

const SDK_SOURCE_PATH = "/foundry/module-sdk/src/index.ts";
const SDK_GENERATOR_SOURCE_PATH = "/foundry/module-sdk/src/generate.ts";
const SDK_DIST_PATH = "/foundry/module-sdk/dist";
const MODULE_SDK_GENERATOR_CORE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "generator-core.ts"
);

export function buildModuleSdkGeneratorSource(): string {
  const core = readFileSync(MODULE_SDK_GENERATOR_CORE, "utf8").trim();
  return `import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

${core}

export async function writeModuleGatewayClient(input: { readonly root: string; readonly catalog: GatewayCatalog }): Promise<string> {
  const root = path.resolve(input.root);
  const manifest = JSON.parse(await readFile(path.join(root, "foundry.module.json"), "utf8")) as unknown;
  const source = generateModuleGatewayClient({ manifest, catalog: input.catalog });
  const output = path.join(root, MODULE_GATEWAY_GENERATED_PATH);
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = output + ".tmp";
  await writeFile(temporary, source, "utf8");
  await rename(temporary, output);
  return source;
}
`;
}

export function emitModuleSdk(): ModuleSdkEmit {
  const files = new Map<string, string>();
  const generatorSource = buildModuleSdkGeneratorSource();
  const options: ts.CompilerOptions = {
    declaration: true,
    module: 99,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    outDir: SDK_DIST_PATH,
    rootDir: "/foundry/module-sdk/src",
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: ["node"],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (sourcePath) => {
    if (sourcePath === SDK_SOURCE_PATH) {
      return MODULE_SDK_ENTRYPOINT;
    }
    if (sourcePath === SDK_GENERATOR_SOURCE_PATH) {
      return generatorSource;
    }
    return readFile(sourcePath);
  };
  host.fileExists = (sourcePath) =>
    sourcePath === SDK_SOURCE_PATH ||
    sourcePath === SDK_GENERATOR_SOURCE_PATH ||
    fileExists(sourcePath);
  host.getSourceFile = (sourcePath, languageVersion) => {
    const source = host.readFile(sourcePath);
    return source === undefined
      ? undefined
      : ts.createSourceFile(sourcePath, source, languageVersion, true);
  };
  host.writeFile = (sourcePath, content) => {
    files.set(sourcePath, content);
  };

  const program = ts.createProgram({
    host,
    options,
    rootNames: [SDK_SOURCE_PATH, SDK_GENERATOR_SOURCE_PATH],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    )
  ) {
    throw new Error(
      `Module SDK source could not be emitted: ${ts.flattenDiagnosticMessageText(diagnostics[0]?.messageText ?? "unknown compiler error", " ")}`
    );
  }
  if (program.emit().emitSkipped) {
    throw new Error("Module SDK compiler skipped its package entrypoint");
  }
  const esm = files.get(`${SDK_DIST_PATH}/index.js`);
  const declarations = files.get(`${SDK_DIST_PATH}/index.d.ts`);
  const generatorEsm = files.get(`${SDK_DIST_PATH}/generate.js`);
  const generatorDeclarations = files.get(`${SDK_DIST_PATH}/generate.d.ts`);
  if (
    esm === undefined ||
    declarations === undefined ||
    generatorEsm === undefined ||
    generatorDeclarations === undefined
  ) {
    throw new Error("Module SDK compiler did not emit its package entrypoint");
  }
  return Object.freeze({
    declarations,
    esm,
    generatorDeclarations,
    generatorEsm,
  });
}

export function renderModuleSdkEmit(emit: ModuleSdkEmit): string {
  const members = Object.entries(emit).map(
    ([name, value]) => `  ${name}: ${JSON.stringify(value)},`
  );
  return [
    "export const MODULE_SDK_EMITTED = {",
    ...members,
    "} as const;",
    "",
  ].join("\n");
}

export function renderModuleSdkGeneratorSource(source: string): string {
  return [
    `export const MODULE_SDK_GENERATOR_ENTRYPOINT = ${JSON.stringify(source)};`,
    "",
  ].join("\n");
}

if (process.argv[1] !== undefined && import.meta.url.startsWith("file:")) {
  const self = fileURLToPath(import.meta.url);
  if (path.resolve(process.argv[1]) === self) {
    const output = path.join(path.dirname(self), "emitted.generated.ts");
    const generatorOutput = path.join(
      path.dirname(self),
      "generator-entrypoint.generated.ts"
    );
    await Promise.all([
      writeFile(output, renderModuleSdkEmit(emitModuleSdk()), "utf8"),
      writeFile(
        generatorOutput,
        renderModuleSdkGeneratorSource(buildModuleSdkGeneratorSource()),
        "utf8"
      ),
    ]);
  }
}
