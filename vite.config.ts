import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  server: {
    port: 5173,
    strictPort: true,
  },
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
