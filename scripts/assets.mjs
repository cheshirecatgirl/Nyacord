// Copies non-TypeScript renderer assets into the compiled output tree so that
// `dist/src/renderer` is directly loadable by the shell WebContentsView.
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "src", "renderer");
const to = join(root, "dist", "src", "renderer");

await mkdir(to, { recursive: true });
await cp(from, to, {
  recursive: true,
  filter: (src) => !src.endsWith(".ts"),
});
