import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// `base: "./"` makes all asset URLs relative so the built index.html works when
// loaded from file:// inside Electron (Brief: desktop renderer).
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // react-pdf 10 references an optional `canvas` dependency that is only
      // needed in Node; alias it to false so Vite does not try to bundle it.
      canvas: resolve(__dirname, "src/lib/empty.ts"),
    },
  },
  optimizeDeps: {
    // pdfjs ships as ESM; pre-bundling keeps dev fast.
    include: ["react-pdf"],
  },
});
