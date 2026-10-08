import path from "node:path";
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

/** @type {import('electron-builder').Configuration} */
const config = {
  afterPack: async (context) => {
    const { productFilename } = context.packager.appInfo;
    const executable =
      context.electronPlatformName === "darwin"
        ? path.join(
            context.appOutDir,
            `${productFilename}.app`,
            "Contents",
            "MacOS",
            productFilename
          )
        : path.join(
            context.appOutDir,
            `${productFilename}${context.electronPlatformName === "win32" ? ".exe" : ""}`
          );

    await flipFuses(executable, {
      resetAdHocDarwinSignature:
        context.electronPlatformName === "darwin" && context.arch === "arm64",
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
  },
  appId: "com.foundry.works",
  asar: true,
  directories: {
    output: "dist/release",
  },
  files: [
    "dist/main/**/*",
    "dist/preload/**/*",
    "dist/renderer/**/*",
    "package.json",
    "src/app/fonts/public-sans/LICENSE.md",
    "src/app/fonts/public-sans/README.md",
    "src/app/fonts/ibm-plex/LICENSE.txt",
    "src/app/fonts/ibm-plex/README.md",
  ],
  linux: {
    target: ["AppImage", "deb", "rpm"],
  },
  mac: {
    target: ["dmg", "zip"],
  },
  // Bun hoists dependencies into the workspace root; rebuilding that tree
  // makes electron-builder run node-gyp for unrelated optional modules.
  npmRebuild: false,
  productName: "Foundry Works",
  win: {
    target: ["nsis"],
  },
};

export default config;
