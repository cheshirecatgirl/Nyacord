// Bundles the preload into a single self-contained file.
//
// This is not an optimization, it is a correctness requirement: a *sandboxed*
// preload script runs with a restricted `require` that can only resolve
// `electron` and a handful of node builtins. A relative `require("../common/ipc")`
// throws at load time and the bridge silently never appears.
//
// Bundling lets the preload keep importing the shared IPC contract — one source
// of truth for channel names across main, preload and renderer — while still
// shipping as a single file the sandbox can load.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, "src", "preload", "shell.ts")],
  outfile: join(root, "dist", "src", "preload", "shell.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // Provided by the sandboxed preload environment, never bundled.
  external: ["electron"],
  legalComments: "none",
  logLevel: "warning",
});
