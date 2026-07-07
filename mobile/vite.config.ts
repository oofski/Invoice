import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served at the site root by the InvoiceIQ worker (Cloudflare Static
// Assets), same origin as the API. `base: "/"` so hashed asset URLs resolve at
// the root and relative `/api/...` calls need no base. Build output → `dist`,
// which the worker's `[assets].directory = "../mobile/dist"` uploads.
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
