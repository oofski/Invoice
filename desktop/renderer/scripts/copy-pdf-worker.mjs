// Copies the pdf.js worker out of node_modules into /public so react-pdf can
// load it from a relative URL that works under file:// in Electron. Runs on
// predev/prebuild so the worker always matches the installed pdfjs-dist.
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const dest = resolve(root, "public/pdf.worker.min.mjs");

try {
  if (!existsSync(src)) {
    console.warn(
      "[copy-pdf-worker] pdfjs-dist not installed yet; skipping (run after npm install).",
    );
    process.exit(0);
  }
  mkdirSync(resolve(root, "public"), { recursive: true });
  copyFileSync(src, dest);
  console.log("[copy-pdf-worker] copied pdf.worker.min.mjs -> public/");
} catch (err) {
  console.error("[copy-pdf-worker] failed:", err.message);
  process.exit(1);
}
