import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build works at any GitHub Pages path
// (https://<owner>.github.io/<repo>/) or a custom domain, unchanged.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
