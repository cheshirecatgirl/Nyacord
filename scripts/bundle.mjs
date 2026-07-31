// Bundles the preload and the shell renderer into single self-contained files.
//
// For the preload this is a correctness requirement, not an optimization: a
// *sandboxed* preload's `require` resolves only `electron` and a few node
// builtins, so a relative import of the shared IPC contract throws at load
// time and the bridge silently never appears.
//
// For the renderer it is what removes duplication. Without a bundler the panel
// script has to be a plain global script, which means re-declaring every type
// and re-typing every constant that already exists in `src/common`. Bundling
// lets it import the real ones, so channel names, accents and rule labels have
// exactly one definition.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = (...parts) => join(root, "src", ...parts);
const out = (...parts) => join(root, "dist", "src", ...parts);

const common = {
  bundle: true,
  legalComments: "none",
  logLevel: "warning",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [src("preload", "shell.ts")],
    outfile: out("preload", "shell.js"),
    format: "cjs",
    platform: "node",
    target: "node20",
    // Provided by the sandboxed preload environment, never bundled.
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: [src("renderer", "shell.ts")],
    outfile: out("renderer", "shell.js"),
    // IIFE, not CJS: the panel is loaded as a classic <script>, where a CJS
    // bundle's top-level `var` declarations become properties of `window`.
    // That collides with the contextBridge-exposed `window.nyacord`, which is
    // read-only, and throws before any UI renders.
    format: "iife",
    platform: "browser",
    target: "chrome120",
  }),
]);
