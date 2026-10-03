// Production bundler: bundles + minifies our TypeScript source into a single
// dist/extension.js. `vscode` is provided by the host. chokidar is bundled in,
// so the package ships no node_modules at all (`vsce package --no-dependencies`);
// esbuild keeps the lazy `require("chokidar")` lazy, so it still isn't loaded
// during activation. `fsevents` is macOS-only, optional, and already inside a
// try/catch in chokidar — left external so the bundle stays cross-platform.
const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    minify: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode", "fsevents"],
    legalComments: "none",
    sourcemap: false,
  })
  .then(() => console.log("bundled -> dist/extension.js"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
